const status = document.querySelector("#status");

function setStatus(value) {
  status.textContent = value;
  status.setAttribute("aria-label", value);
}

document.querySelector("#pass").addEventListener("click", () => {
  setStatus("Passed");
});

document.querySelector("#flaky").addEventListener("click", () => {
  if (localStorage.getItem("flaky-action-seen")) {
    setStatus("Ready after retry");
    return;
  }

  localStorage.setItem("flaky-action-seen", "yes");
  setStatus("Not ready yet");
});

document.querySelector("#reset").addEventListener("click", () => {
  localStorage.removeItem("flaky-action-seen");
  setStatus("Reset");
});

document.querySelector("#message").addEventListener("input", (event) => {
  setStatus(`Typed ${event.target.value}`);
});

document.querySelector("#message").addEventListener("keydown", (event) => {
  if (event.key === "Enter") setStatus("Submitted");
});
