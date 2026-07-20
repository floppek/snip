const MAX_FILE_BYTES = 100 * 1024 * 1024;

const fileInput = document.querySelector("#file");
const uploadTarget = document.querySelector("#upload-target");
const form = document.querySelector("#upload-form");
const uploadButton = document.querySelector("#upload-button");
const cancelButton = document.querySelector("#cancel-button");
const summary = document.querySelector("#file-summary");
const domainSelect = document.querySelector("#domain");
const domainHint = document.querySelector("#domain-hint");
const progress = document.querySelector("#progress");
const progressBar = document.querySelector("#progress-bar");
const stage = document.querySelector("#stage");
const percent = document.querySelector("#percent");
const bytes = document.querySelector("#bytes");
const message = document.querySelector("#message");
const apiStatus = document.querySelector("#api-status");

let selectedFile;
let activeRequest;

void initialize();

fileInput.addEventListener("change", () => selectFile(fileInput.files[0]));
uploadTarget.addEventListener("dragover", (event) => {
    event.preventDefault();
    uploadTarget.classList.add("is-dragging");
});
uploadTarget.addEventListener("dragleave", () => {
    uploadTarget.classList.remove("is-dragging");
});
uploadTarget.addEventListener("drop", (event) => {
    event.preventDefault();
    uploadTarget.classList.remove("is-dragging");
    selectFile(event.dataTransfer.files[0]);
});
uploadTarget.addEventListener("dragend", () => {
    uploadTarget.classList.remove("is-dragging");
});
cancelButton.addEventListener("click", () => activeRequest?.abort());
form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (selectedFile) upload(selectedFile);
});

async function initialize() {
    await Promise.all([loadHealth(), loadDomains()]);
}

async function loadHealth() {
    try {
        const response = await fetch("/api/health");
        const health = await response.json();
        apiStatus.textContent = health.configured
            ? "api: connected"
            : "api: missing key";
        apiStatus.classList.toggle("error", !health.configured);
    } catch {
        apiStatus.textContent = "api: unavailable";
        apiStatus.classList.add("error");
    }
}

async function loadDomains() {
    try {
        const response = await fetch("/api/domains");
        const payload = await response.json();
        if (!response.ok || !Array.isArray(payload.domains) || payload.domains.length === 0) {
            throw new Error(payload?.error?.message || "Domains unavailable.");
        }

        domainSelect.replaceChildren(
            ...payload.domains.map((domain) => {
                const option = document.createElement("option");
                option.value = domain;
                option.textContent = domain;
                return option;
            }),
        );
        domainSelect.disabled = false;
        domainHint.textContent = `${payload.domains.length} domains available`;
    } catch {
        const option = document.createElement("option");
        option.value = "nest.rip";
        option.textContent = "nest.rip";
        domainSelect.replaceChildren(option);
        domainSelect.disabled = false;
        domainHint.textContent = "domain list unavailable; nest.rip will be used";
    }
}

function selectFile(file) {
    selectedFile = file;
    clearMessage();
    progress.hidden = true;

    if (!file) {
        summary.textContent = "no file selected";
        uploadButton.disabled = true;
        return;
    }

    summary.textContent = `${file.name} · ${formatBytes(file.size)} · ${file.type || "application/octet-stream"}`;
    if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
        showError(
            file.size > MAX_FILE_BYTES
                ? "file is too large (maximum 100 MB)"
                : "this file is empty",
        );
        uploadButton.disabled = true;
        return;
    }
    uploadButton.disabled = false;
}

function upload(file) {
    clearMessage();
    setProgress("uploading", 0, file.size);
    uploadButton.disabled = true;
    cancelButton.hidden = false;

    const body = new FormData();
    body.set("file", file, file.name);

    const request = new XMLHttpRequest();
    activeRequest = request;
    request.open("POST", "/api/upload");
    request.setRequestHeader("X-Snip-Size", String(file.size));
    request.setRequestHeader("X-Snip-Domain", domainSelect.value || "nest.rip");

    request.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
            setProgress("uploading", event.loaded, event.total);
        }
    });
    request.addEventListener("load", () => {
        let payload;
        try {
            payload = JSON.parse(request.responseText);
        } catch {
            finishWithError("server returned an invalid response");
            return;
        }
        if (request.status < 200 || request.status >= 300) {
            finishWithError(payload?.error?.message || "upload failed");
            return;
        }
        if (!payload?.result?.url) {
            finishWithError("upload completed without a usable link");
            return;
        }
        setProgress("done", file.size, file.size);
        showResult(payload.result);
        finish();
    });
    request.addEventListener("error", () => {
        finishWithError("upload failed");
    });
    request.addEventListener("abort", () => {
        finishWithError("upload canceled");
    });
    request.send(body);
}

function finish() {
    activeRequest = undefined;
    cancelButton.hidden = true;
    uploadButton.disabled = !selectedFile;
}

function finishWithError(text) {
    progress.hidden = true;
    showError(text);
    finish();
}

function setProgress(label, loaded, total) {
    progress.hidden = false;
    stage.textContent = label;
    const value = total
        ? Math.min(100, Math.round((loaded / total) * 100))
        : 0;
    percent.textContent = `${value}%`;
    bytes.textContent = `${formatBytes(loaded)} / ${formatBytes(total)}`;
    progressBar.style.width = `${value}%`;
}

function showResult(result) {
    clearMessage();
    message.className = "message success";

    const title = document.createElement("strong");
    title.textContent = `uploaded: ${result.fileName || selectedFile.name}`;

    const link = document.createElement("a");
    link.className = "result-url";
    link.href = result.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = result.url;

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy link";
    copyButton.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(result.url);
            copyButton.textContent = "Copied";
        } catch {
            copyButton.textContent = "Copy failed";
        }
    });

    message.append(title, link, copyButton);
}

function showError(text) {
    message.className = "message error";
    message.textContent = text;
}

function clearMessage() {
    message.className = "message";
    message.textContent = "";
}

function formatBytes(value) {
    if (!Number.isFinite(value) || value <= 0) {
        return "0 B";
    }
    const units = ["B", "KB", "MB"];
    const index = Math.min(
        units.length - 1,
        Math.floor(Math.log(value) / Math.log(1024)),
    );
    return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
