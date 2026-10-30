const API_BASE = "http://127.0.0.1:8000";
const MAX_STEPS = 12;
const goalInput = document.getElementById("goal");
const stepOnceButton = document.getElementById("step-once");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const statusText = document.getElementById("status");
const siteLabel = document.getElementById("site-label");
const activity = document.getElementById("activity");
const approval = document.getElementById("approval");
const approvalTitle = document.getElementById("approval-title");
const approvalMessage = document.getElementById("approval-message");
const approveButton = document.getElementById("approve");
const rejectButton = document.getElementById("reject");

let activeTabId = null;
let selectedTab = null;
let activeGoal = "";
let running = false;
let isSingleStep = false;
let pendingPlan = null;
let pendingKind = null;
let pendingTarget = null;
let history = [];

function formatErrorDetail(detail) {
  if (Array.isArray(detail)) {
    return detail.map((item) => item.msg || JSON.stringify(item)).join("; ");
  }
  if (typeof detail === "object" && detail !== null) {
    return detail.msg || JSON.stringify(detail);
  }
  return String(detail || "Unknown error");
}

function updateButtons() {
  const disabled =
    running || Boolean(pendingPlan) || !originPattern(selectedTab?.url || "");
  startButton.disabled = disabled;
  if (stepOnceButton) {
    stepOnceButton.disabled = disabled;
  }
  stopButton.disabled = !running;
}

function setStatus(message) {
  statusText.textContent = message;
}

function log(message) {
  const item = document.createElement("li");
  item.textContent = message;
  activity.prepend(item);
}

function showApproval(kind, plan, target) {
  pendingPlan = plan;
  pendingKind = kind;
  pendingTarget = target;
  approvalTitle.textContent =
    kind === "site"
      ? "Permission needed for another site"
      : "Review this consequential action";
  approvalMessage.textContent =
    kind === "site"
      ? `AccessMate wants to open ${target.external_origin} and read its visible controls.`
      : `${plan.reason} Proposed action: ${plan.action} ${
          target ? `"${target.label}"` : ""
        }${plan.action === "type" ? ` with "${plan.value}"` : ""}`;
  approval.classList.remove("hidden");
  approveButton.textContent = kind === "site" ? "Allow site and continue" : "Approve once";
  setStatus("Paused for your review.");
  updateButtons();
  approvalTitle.setAttribute("tabindex", "-1");
  approvalTitle.focus();
}

function hideApproval() {
  pendingPlan = null;
  pendingKind = null;
  pendingTarget = null;
  approval.classList.add("hidden");
  updateButtons();
}

function originPattern(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

async function grantSiteAccess(pattern) {
  return chrome.permissions.request({ origins: [pattern] });
}

async function sendToPage(message) {
  if (!activeTabId) {
    throw new Error("No active website tab is selected.");
  }
  try {
    return await chrome.tabs.sendMessage(activeTabId, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ["content.js"],
    });
    return chrome.tabs.sendMessage(activeTabId, message);
  }
}

function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function getSnapshot() {
  const response = await sendToPage({ type: "accessmate:snapshot" });
  if (!response?.ok || !response.page) {
    throw new Error("Could not read the visible controls on this page.");
  }
  return response.page;
}

async function requestPlan(page) {
  const response = await fetch(`${API_BASE}/api/agent/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      goal: activeGoal,
      page_title: page.title,
      page_origin: page.origin,
      elements: page.elements,
      history: history.slice(-8),
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(formatErrorDetail(data.detail));
  }
  return data;
}

function findTarget(page, plan) {
  return page.elements.find((element) => element.id === plan.element_id) || null;
}

function isConsequential(plan, target) {
  if (plan.action !== "click") {
    return false;
  }
  if (target?.submits_form) {
    return true;
  }
  const words = `${target?.label || ""} ${plan.reason}`.toLowerCase();
  return /\b(log ?in|log ?out|sign ?in|sign ?up|authenticate|authentication|authorize|credential|password|2fa|mfa|security|account|payment|bank|submit|send|share|delete|remove|cancel|transfer|approve|confirm|purchase|buy|pay|checkout|save|update|apply|place order|subscribe|unsubscribe|publish|install|download|permission|allow access|grant|revoke|withdraw|refund|wallet|crypto|close account)\b/.test(
    words
  );
}

async function execute(plan, target = null) {
  const response = await sendToPage({
    type: "accessmate:execute",
    action: plan.action,
    element_id: plan.element_id,
    value: plan.value,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "The page did not complete the proposed action.");
  }
  log(response.description || plan.reason);
  const targetDesc = target ? ` "${target.label}"` : (plan.element_id ? ` ${plan.element_id}` : "");
  const valDesc = plan.value ? ` ("${plan.value}")` : "";
  history.push(`${plan.action} on ${targetDesc}${valDesc}: ${plan.reason}`);
}

function pauseForApproval(kind, plan, target) {
  running = false;
  showApproval(kind, plan, target);
}

async function runLoop(maxSteps = MAX_STEPS) {
  running = true;
  hideApproval();
  updateButtons();
  let lastPlanSignature = null;

  try {
    for (let step = 0; step < maxSteps && running; step += 1) {
      setStatus(maxSteps === 1 ? "Planning single step..." : `Planning step ${step + 1} of ${maxSteps}...`);
      const page = await getSnapshot();
      if (!running) {
        break;
      }
      siteLabel.textContent = `${page.title || "Website"} - ${page.origin}`;
      const plan = await requestPlan(page);
      if (!running) {
        break;
      }
      const target = findTarget(page, plan);

      if (plan.action === "done") {
        running = false;
        setStatus(plan.reason || "Task complete.");
        log(plan.reason || "Task complete.");
        break;
      }
      if (plan.action === "ask_user") {
        running = false;
        setStatus(plan.reason);
        log(`Paused: ${plan.reason}`);
        break;
      }
      if (plan.action === "click" && !target) {
        throw new Error("The plan refers to a control that is not on this page.");
      }
      if (plan.action === "type" && target?.sensitive) {
        running = false;
        setStatus(`Fill "${target.label}" yourself, then start the agent again.`);
        log("Sensitive fields are never filled by the agent.");
        break;
      }

      // Loop / duplicate prevention: if the model proposes the exact same action and element consecutively, stop!
      const currentSignature = `${plan.action}:${plan.element_id || ""}:${plan.value || ""}`;
      if (lastPlanSignature && currentSignature === lastPlanSignature) {
        running = false;
        setStatus(`Task complete: ${plan.reason || "Action already executed."}`);
        log(`Task complete: Action was already performed.`);
        break;
      }
      lastPlanSignature = currentSignature;

      const destinationPattern =
        plan.action === "click" && target?.external_origin
          ? `${target.external_origin}/*`
          : null;
      if (
        destinationPattern &&
        !(await chrome.permissions.contains({ origins: [destinationPattern] }))
      ) {
        pauseForApproval("site", plan, target);
        break;
      }
      if (!running) {
        break;
      }
      if (isConsequential(plan, target)) {
        pauseForApproval("action", plan, target);
        break;
      }

      await execute(plan, target);
      await waitForTabLoad(activeTabId, 5000);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    if (running) {
      running = false;
      if (maxSteps === 1) {
        setStatus("Single step completed.");
      } else {
        setStatus(`Paused after ${maxSteps} steps. Review the page, then start again if needed.`);
        log(`Agent paused after ${maxSteps} steps.`);
      }
    }
  } catch (error) {
    running = false;
    setStatus(error.message || "The agent stopped because of an unexpected error.");
    log(`Stopped: ${error.message || "Unexpected error."}`);
  } finally {
    updateButtons();
  }
}

async function startAgent(stepsToRun) {
  if (running || pendingPlan) {
    return;
  }
  const goal = goalInput.value.trim();
  if (!goal) {
    setStatus("Enter a goal before starting.");
    return;
  }

  try {
    const tab = selectedTab;
    const pattern = originPattern(tab?.url || "");
    if (!tab?.id || !pattern) {
      throw new Error("Select an ordinary website tab before starting the agent.");
    }
    const origin = new URL(tab.url).origin;
    setStatus(`Requesting access to ${origin}...`);
    running = true;
    updateButtons();
    const permissionRequest = grantSiteAccess(pattern);
    if (!(await permissionRequest)) {
      running = false;
      updateButtons();
      setStatus("Site access was not granted.");
      return;
    }
    activeTabId = tab.id;
    activeGoal = goal;
    history = [];
    setStatus("Starting the agent…");
    await runLoop(stepsToRun);
  } catch (error) {
    running = false;
    updateButtons();
    setStatus(error.message || "The agent could not start.");
  }
}

if (stepOnceButton) {
  stepOnceButton.addEventListener("click", () => {
    isSingleStep = true;
    startAgent(1);
  });
}

startButton.addEventListener("click", () => {
  isSingleStep = false;
  startAgent(MAX_STEPS);
});

stopButton.addEventListener("click", () => {
  running = false;
  hideApproval();
  updateButtons();
  setStatus("Stopped.");
});

approveButton.addEventListener("click", async () => {
  const plan = pendingPlan;
  const kind = pendingKind;
  const target = pendingTarget;
  if (!plan || !kind) {
    return;
  }

  try {
    if (kind === "site") {
      const destinationPattern = `${target?.external_origin || ""}/*`;
      const permissionRequest = grantSiteAccess(destinationPattern);
      if (!(await permissionRequest)) {
        hideApproval();
        updateButtons();
        setStatus("Site access was not granted; the action was not taken.");
        return;
      }
      if (isConsequential(plan, target)) {
        showApproval("action", plan, target);
        return;
      }
    } else if (isConsequential(plan, target)) {
      log("You approved this action once.");
    }
    hideApproval();
    running = true;
    updateButtons();
    await execute(plan, target);
    await waitForTabLoad(activeTabId, 5000);
    await new Promise((resolve) => setTimeout(resolve, 300));

    if (!isSingleStep) {
      await runLoop(MAX_STEPS);
    } else {
      running = false;
      updateButtons();
      setStatus("Approved step completed.");
    }
  } catch (error) {
    hideApproval();
    running = false;
    updateButtons();
    setStatus(error.message || "The approved action could not be completed.");
  }
});

rejectButton.addEventListener("click", () => {
  hideApproval();
  running = false;
  updateButtons();
  setStatus("Action rejected. Nothing was done.");
  log("You rejected the proposed action.");
});

async function refreshSelectedTab(tabId) {
  try {
    selectedTab = await chrome.tabs.get(tabId);
    const origin = originPattern(selectedTab.url || "")
      ? new URL(selectedTab.url).origin
      : "This tab cannot be controlled.";
    siteLabel.textContent = selectedTab.url
      ? `${selectedTab.title || "Website"} - ${origin}`
      : origin;
    updateButtons();
  } catch (error) {
    selectedTab = null;
    siteLabel.textContent = `Could not read the active tab: ${error.message}`;
    updateButtons();
  }
}

chrome.tabs
  .query({ active: true, lastFocusedWindow: true })
  .then(([tab]) => {
    if (tab?.id) {
      return refreshSelectedTab(tab.id);
    }
    siteLabel.textContent = "Choose a website tab to begin.";
    updateButtons();
  })
  .catch((error) => {
    siteLabel.textContent = `Could not read the active tab: ${error.message}`;
    updateButtons();
  });

chrome.tabs.onActivated.addListener(({ tabId }) => {
  refreshSelectedTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (selectedTab?.id === tabId) {
    selectedTab = { ...selectedTab, ...tab };
    const origin = originPattern(selectedTab.url || "")
      ? new URL(selectedTab.url).origin
      : "This tab cannot be controlled.";
    siteLabel.textContent = selectedTab.url
      ? `${selectedTab.title || "Website"} - ${origin}`
      : origin;
    updateButtons();
  }
  if (tabId === activeTabId && changeInfo.status === "complete" && tab.url) {
    const pattern = originPattern(tab.url);
    if (pattern) {
      chrome.permissions
        .contains({ origins: [pattern] })
        .then((allowed) => {
          if (!allowed && running) {
            running = false;
            setStatus("The page changed to a site that has not been approved yet.");
          }
        })
        .catch((error) => {
          running = false;
          setStatus(`Could not verify site access: ${error.message}`);
        });
    }
  }
});
