const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD = 128 * 1024;
const NEST_UPLOAD_URL = "https://nest.rip/api/files/upload";
const NEST_DOMAINS_URL = "https://nest.rip/api/domains";

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/api/health") {
            return json({
                ok: Boolean(env.NEST_API_KEY),
                configured: Boolean(env.NEST_API_KEY),
                application: "snip"
            });
        }

        if (request.method === "GET" && url.pathname === "/api/domains") {
            return handleApiRequest(request, url, () => handleDomains(env));
        }

        if (request.method === "POST" && url.pathname === "/api/upload") {
            return handleApiRequest(request, url, () => handleUpload(request, env));
        }

        return env.ASSETS.fetch(request);
    }
};

async function handleApiRequest(request, url, handler) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) {
        return json({ error: { message: "cross-origin requests are not allowed" } }, 403);
    }

    try {
        return await handler();
    } catch {
        return json({ error: { message: "unexpected server error" } }, 500);
    }
}

async function handleDomains(env) {
    if (!env.NEST_API_KEY) {
        return json({ error: { message: "nest.rip key is not configured" } }, 503);
    }

    try {
        return json({ domains: await getNestDomains(env.NEST_API_KEY) });
    } catch {
        return json({ error: { message: "nest.rip domains are unavailable" } }, 502);
    }
}

async function handleUpload(request, env) {
    if (!env.NEST_API_KEY) {
        return json({ error: { message: "nest.rip key is not configured" } }, 503);
    }

    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
        return json({ error: { message: "invalid multipart content type" } }, 400);
    }

    const fileSize = Number(request.headers.get("X-Snip-Size"));
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
        return json({ error: { message: "invalid file size" } }, 400);
    }
    if (fileSize > MAX_FILE_BYTES) {
        return json({ error: { message: "file is too large (maximum 100 MB)" } }, 413);
    }

    const contentLength = Number(request.headers.get("Content-Length"));
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
        return json({ error: { message: "upload size could not be verified" } }, 411);
    }
    if (contentLength < fileSize || contentLength > MAX_FILE_BYTES + MAX_MULTIPART_OVERHEAD) {
        return json({ error: { message: "upload exceeds the 100 MB file limit" } }, 413);
    }
    if (!request.body) {
        return json({ error: { message: "upload body is empty" } }, 400);
    }

    const requestedDomain = normalizeDomain(request.headers.get("X-Snip-Domain"));
    let domains;
    try {
        domains = await getNestDomains(env.NEST_API_KEY);
    } catch {
        return json({ error: { message: "nest.rip domains are unavailable" } }, 502);
    }

    const selectedDomain = domains.find((domain) => domain.toLowerCase() === requestedDomain);
    if (!selectedDomain) {
        return json({ error: { message: "selected domain is not available" } }, 400);
    }

    let upstream;
    try {
        upstream = await fetch(NEST_UPLOAD_URL, {
            method: "POST",
            headers: {
                Authorization: env.NEST_API_KEY,
                "Content-Type": contentType,
                "Content-Length": String(contentLength)
            },
            body: request.body,
            redirect: "manual"
        });
    } catch {
        return json({ error: { message: "could not reach nest.rip" } }, 502);
    }

    const payload = await readJson(upstream);
    if (!upstream.ok) {
        const message = nestErrorMessage(payload) ||
            `nest.rip rejected the upload (${upstream.status}).`;
        const status = upstream.status === 429
            ? 429
            : upstream.status >= 400 && upstream.status < 500
                ? upstream.status
                : 502;
        return json({ error: { message } }, status);
    }

    const item = Array.isArray(payload) ? payload[0] : payload;
    const rawUrl = firstString(
        item?.accessibleURL,
        item?.accessibleUrl,
        item?.fileURL,
        item?.fileUrl,
        item?.url
    );
    if (!rawUrl) {
        return json({ error: { message: "nest.rip uploaded the file but returned no usable URL" } }, 502);
    }

    let finalUrl;
    try {
        const changedUrl = new URL(rawUrl);
        if (changedUrl.protocol !== "https:") {
            throw new Error("Unexpected URL protocol.");
        }
        changedUrl.hostname = selectedDomain;
        changedUrl.port = "";
        finalUrl = changedUrl.toString();
    } catch {
        return json({ error: { message: "nest.rip returned an invalid file URL" } }, 502);
    }

    return json({
        result: {
            fileName: firstString(item?.originalFilename, item?.fileName, item?.name) || "file",
            url: finalUrl,
            domain: selectedDomain
        }
    });
}

async function getNestDomains(apiKey) {
    const response = await fetch(NEST_DOMAINS_URL, {
        headers: {
            Authorization: apiKey,
            Accept: "application/json"
        }
    });
    if (!response.ok) throw new Error("Domain request failed.");

    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("Invalid domain response.");

    const domains = ["nest.rip", ...payload.map((item) => item?.domain)]
        .filter((domain) => typeof domain === "string" && isHostname(domain));
    return [...new Map(domains.map((domain) => [domain.toLowerCase(), domain])).values()];
}

function normalizeDomain(value) {
    return (value || "nest.rip").trim().toLowerCase();
}

function nestErrorMessage(payload) {
    return firstString(
        payload?.message,
        payload?.error?.message,
        payload?.error,
        payload?.detail
    );
}

async function readJson(response) {
    try {
        return await response.json();
    } catch {
        return {};
    }
}

function firstString(...values) {
    return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function isHostname(value) {
    return value.length <= 253 &&
        /^[a-z0-9.-]+$/i.test(value) &&
        !value.includes("..") &&
        !value.startsWith(".") &&
        !value.endsWith(".");
}

function json(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY"
        }
    });
}
