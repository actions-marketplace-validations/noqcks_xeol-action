const cache = require("@actions/tool-cache");
const core = require("@actions/core");
const exec = require("@actions/exec");
const fs = require("fs");
const stream = require("stream");
const { XEOL_VERSION } = require("./XeolVersion");

const xeolBinary = "xeol";
const xeolVersion = core.getInput("xeol-version") || XEOL_VERSION;

async function downloadXeol(version) {
  let url = `https://raw.githubusercontent.com/noqcks/xeol/main/install.sh`;

  core.debug(`Installing ${version}`);

  // TODO: when xeol starts supporting unreleased versions, support it here
  // Download the installer, and run
  const installPath = await cache.downloadTool(url);
  // Make sure the tool's executable bit is set
  await exec.exec(`chmod +x ${installPath}`);

  let cmd = `${installPath} -b ${installPath}_xeol ${version}`;
  await exec.exec(cmd);
  let xeolPath = `${installPath}_xeol/xeol`;

  // Cache the downloaded file
  return cache.cacheFile(xeolPath, `xeol`, `xeol`, version);
}

async function installXeol(version) {
  let xeolPath = cache.find(xeolBinary, version);
  if (!xeolPath) {
    // Not found, install it
    xeolPath = await downloadXeol(version);
  }

  // Add tool to path for this and future actions to use
  core.addPath(xeolPath);
  return `${xeolPath}/${xeolBinary}`;
}

// Determines if multiple arguments are defined
function multipleDefined(...args) {
  let defined = false;
  for (const a of args) {
    if (defined && a) {
      return true;
    }
    if (a) {
      defined = true;
    }
  }
  return false;
}

function sourceInput() {
  var image = core.getInput("image");
  var path = core.getInput("path");
  var sbom = core.getInput("sbom");

  if (multipleDefined(image, path, sbom)) {
    throw new Error(
      "The following options are mutually exclusive: image, path, sbom"
    );
  }

  if (image) {
    return image;
  }

  if (sbom) {
    return "sbom:" + sbom;
  }

  if (!path) {
    // Default to the CWD
    path = ".";
  }

  return "dir:" + path;
}

async function run() {
  try {
    core.debug(new Date().toTimeString());
    // Xeol accepts several input options, initially this action is supporting both `image` and `path`, so
    // a check must happen to ensure one is selected at least, and then return it
    const source = sourceInput();
    const failBuild = core.getInput("fail-build") || "true";
    const outputFormat = core.getInput("output-format") || "sarif";
    const severityCutoff = core.getInput("severity-cutoff") || "medium";
    const onlyFixed = core.getInput("only-fixed") || "false";
    const out = await runScan({
      source,
      failBuild,
      severityCutoff,
      onlyFixed,
      outputFormat,
    });
    Object.keys(out).map((key) => {
      core.setOutput(key, out[key]);
    });
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function runScan({ source, failBuild, severityCutoff, onlyFixed, outputFormat }) {
  const out = {};

  const env = {
    ...process.env,
    XEOL_CHECK_FOR_APP_UPDATE: "false",
  };

  const registryUser = core.getInput("registry-username");
  const registryPass = core.getInput("registry-password");

  if (registryUser || registryPass) {
    env.XEOL_REGISTRY_AUTH_USERNAME = registryUser;
    env.XEOL_REGISTRY_AUTH_PASSWORD = registryPass;
    if (!registryUser || !registryPass) {
      core.warning(
        "WARNING: registry-username and registry-password must be specified together"
      );
    }
  }

  const SEVERITY_LIST = ["negligible", "low", "medium", "high", "critical"];
  const FORMAT_LIST = ["sarif", "json", "table"];
  let cmdArgs = [];

  if (core.isDebug()) {
    cmdArgs.push(`-vv`);
  }

  failBuild = failBuild.toLowerCase() === "true";
  onlyFixed = onlyFixed.toLowerCase() === "true";

  cmdArgs.push("-o", outputFormat);

  if (
    !SEVERITY_LIST.some(
      (item) =>
        typeof severityCutoff.toLowerCase() === "string" &&
        item === severityCutoff.toLowerCase()
    )
  ) {
    throw new Error(
      `Invalid severity-cutoff value is set to ${severityCutoff} - please ensure you are choosing either negligible, low, medium, high, or critical`
    );
  }
  if (
    !FORMAT_LIST.some(
      (item) =>
        typeof outputFormat.toLowerCase() === "string" &&
        item === outputFormat.toLowerCase()
    )
  ) {
    throw new Error(
      `Invalid output-format value is set to ${outputFormat} - please ensure you are choosing either json or sarif`
    );
  }

  core.debug(`Installing xeol version ${xeolVersion}`);
  await installXeol(xeolVersion);

  core.debug("Source: " + source);
  core.debug("Fail Build: " + failBuild);
  core.debug("Severity Cutoff: " + severityCutoff);
  core.debug("Only Fixed: " + onlyFixed);
  core.debug("Output Format: " + outputFormat);

  core.debug("Creating options for Xeol analyzer");

  // Run the xeol analyzer
  let cmdOutput = "";
  let cmd = `${xeolBinary}`;
  if (severityCutoff !== "") {
    cmdArgs.push("--fail-on");
    cmdArgs.push(severityCutoff.toLowerCase());
  }
  if (onlyFixed === true) {
    cmdArgs.push("--only-fixed");
  }
  cmdArgs.push(source);

  // This /dev/null writable stream is required so the entire Xeol output
  // is not written to the GitHub action log. the listener below
  // will actually capture the output
  const outStream = new stream.Writable({
    write(buffer, encoding, next) {
      next();
    },
  });

  const exitCode = await core.group(`${cmd} output...`, async () => {
    core.info(`Executing: ${cmd} ` + cmdArgs.join(" "));

    return exec.exec(cmd, cmdArgs, {
      env,
      ignoreReturnCode: true,
      outStream,
      listeners: {
        stdout(buffer) {
          cmdOutput += buffer.toString();
        },
        stderr(buffer) {
          core.info(buffer.toString());
        },
        debug(message) {
          core.debug(message);
        },
      },
    });
  });

  if (core.isDebug()) {
    core.debug("Xeol output:");
    core.debug(cmdOutput);
  }

  switch (outputFormat) {
    case "sarif": {
      const SARIF_FILE = "./results.sarif";
      fs.writeFileSync(SARIF_FILE, cmdOutput);
      out.sarif = SARIF_FILE;
      break;
    }
    case "json": {
      const REPORT_FILE = "./results.json";
      fs.writeFileSync(REPORT_FILE, cmdOutput);
      out.report = REPORT_FILE;
      break;
    }
    default: // e.g. table
      core.info(cmdOutput);
  }

  // If there is a non-zero exit status code there are a couple of potential reporting paths
  if (exitCode > 0) {
    if (!severityCutoff) {
      // There was a non-zero exit status but it wasn't because of failing severity, this must be
      // a xeol problem
      core.warning("xeol had a non-zero exit status when running");
    } else if (failBuild === true) {
      core.setFailed(
        `Failed minimum severity level. Found vulnerabilities with level '${severityCutoff}' or higher`
      );
    } else {
      // There is a non-zero exit status code with severity cut off, although there is still a chance this is xeol
      // that is broken, it will most probably be a failed severity. Using warning here will make it bubble up in the
      // Actions UI
      core.warning(
        `Failed minimum severity level. Found vulnerabilities with level '${severityCutoff}' or higher`
      );
    }
  }

  return out;
}

module.exports = {
  run,
  runScan,
  installXeol,
};

if (require.main === module) {
  const entrypoint = core.getInput("run");
  switch (entrypoint) {
    case "download-xeol": {
      installXeol(xeolVersion).then((path) => {
        core.info(`Downloaded Xeol to: ${path}`);
        core.setOutput("cmd", path);
      });
      break;
    }
    default: {
      run().then();
    }
  }
}
