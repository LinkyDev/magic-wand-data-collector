const extensionApi = typeof browser !== "undefined" ? browser : chrome;

const startButton = document.getElementById("start-session");
const statusElement = document.getElementById("session-status");

function setStatus(message, visible = true) {
  if (!statusElement) {
    return;
  }
  statusElement.textContent = message;
  statusElement.hidden = !visible;
}

async function initialize() {
  try {
    const response = await extensionApi.runtime.sendMessage({ type: "getSessionSummary" });
    if (response?.ok && response.state?.active) {
      setStatus("A collection session is already active.");
      startButton.textContent = "Resume Setup";
    } else {
      setStatus("");
    }
  } catch (error) {
    setStatus(`Unable to read extension state: ${error.message}`);
  }
}

startButton?.addEventListener("click", async () => {
  startButton.disabled = true;
  try {
    const response = await extensionApi.runtime.sendMessage({ type: "launchSetup" });
    if (!response?.ok) {
      throw new Error(response?.error ?? "Unable to launch setup");
    }
    window.close();
  } catch (error) {
    setStatus(error.message || "Failed to open the setup page.");
    startButton.disabled = false;
  }
});

initialize();
