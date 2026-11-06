/**
 * The embed script: turns `<div data-gym-lead-form="https://…/l/{gym}/{form}">` into an iframe of
 * the form's embed variant, passing the host page's UTM tags and referrer along. No cookies, no
 * tracking of its own.
 */
const SCRIPT = `(function () {
  var params = new URLSearchParams(window.location.search);
  var keys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  document.querySelectorAll("[data-gym-lead-form]").forEach(function (el) {
    if (el.getAttribute("data-gym-ready")) return;
    var src;
    try { src = new URL(el.getAttribute("data-gym-lead-form")); } catch (e) { return; }
    src.pathname = src.pathname.replace(/\\/$/, "") + "/embed";
    keys.forEach(function (k) { if (params.get(k)) src.searchParams.set(k, params.get(k)); });
    if (document.referrer) src.searchParams.set("referrer", document.referrer.slice(0, 300));
    var frame = document.createElement("iframe");
    frame.src = src.toString();
    frame.title = "Enquiry form";
    frame.loading = "lazy";
    frame.style.width = "100%";
    frame.style.minHeight = el.getAttribute("data-height") || "640px";
    frame.style.border = "0";
    el.appendChild(frame);
    el.setAttribute("data-gym-ready", "1");
  });
})();`;

export function GET() {
  return new Response(SCRIPT, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
