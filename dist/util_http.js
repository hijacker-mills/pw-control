export async function requestJson(url, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        return res.json();
    }
    finally {
        clearTimeout(timeout);
    }
}
