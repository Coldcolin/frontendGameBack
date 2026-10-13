// Builds the locked render document used by the official grader. The frontend
// sandbox (frontend/lib/sandbox.ts) builds the same shell, so live and
// official scores render identically.

const BLOCKED_TAGS = /<\s*\/?\s*(script|iframe|object|embed|link|meta|base|frame|frameset)\b[^>]*>/gi;
const SCRIPT_BLOCKS = /<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi;
const EVENT_ATTRS = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URLS = /(href|src|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi;

export function sanitizeCode(code: string): string {
  return code
    .replace(SCRIPT_BLOCKS, "")
    .replace(BLOCKED_TAGS, "")
    .replace(EVENT_ATTRS, "")
    .replace(JS_URLS, "");
}

// `!important` keeps contender CSS from restyling the page shell, which the
// live capture (#root only) and the grader (full page) would see differently.
export const CANVAS_RESET = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0!important;padding:0!important;width:600px!important;height:400px!important;overflow:hidden!important;background:#fff!important}
#root{position:relative!important;width:600px!important;height:400px!important;overflow:hidden!important}`;

export function renderDocument(code: string, tailwindRuntime: string, nonce: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>${CANVAS_RESET}</style>
<script nonce="${nonce}">${tailwindRuntime}</script>
</head><body><div id="root">${sanitizeCode(code)}</div></body></html>`;
}
