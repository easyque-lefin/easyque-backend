/* status.js – client for Live Queue Status + Reviews
   Expects backend:
   GET  /status/view?org_id=...&booking_id=... (or token/phone)
        → { ok, org:{id,name,banner,map_url,google_review_url}, booking:{...}, metrics:{...} }
   POST /reviews/create  (fallback: /reviews/add or /reviews)
        body: { org_id, booking_id, rating, review, name }
        → { ok:true }
*/

const $ = (sel) => document.querySelector(sel);

const qs = new URLSearchParams(location.search);
const ORG_ID = qs.get("org_id");
const BOOKING_ID = qs.get("booking_id") || null;
const TOKEN = qs.get("token") || null;
const PHONE = qs.get("phone") || null;

let lastPayload = null;
let pickedStars = 0;

/* ---------- Helpers ---------- */
const fmtTime = (d) =>
  d ? new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
const fmtDateTime = (d) =>
  d ? new Date(d).toLocaleString([], { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

/* ---------- Load status ---------- */
async function fetchStatus() {
  if (!ORG_ID) {
    alert("Missing org_id");
    return;
  }
  const url =
    `/status/view?org_id=${encodeURIComponent(ORG_ID)}` +
    (BOOKING_ID ? `&booking_id=${encodeURIComponent(BOOKING_ID)}` : "") +
    (TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : "") +
    (PHONE ? `&phone=${encodeURIComponent(PHONE)}` : "");

  const res = await fetch(url, { credentials: "same-origin" });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(json.error || "Failed to load");
  lastPayload = json;
  paint(json);
}

/* ---------- Paint UI ---------- */
function paint({ org, booking, metrics }) {
  // org name + map icon + banner
  $("#orgName").textContent = org?.name ?? "Organization";
  if (org?.map_url) {
    $("#mapBtn").hidden = false;
    $("#mapBtn").href = org.map_url;
  } else {
    $("#mapBtn").hidden = true;
  }
  if (org?.banner) {
    $("#bannerImg").src = org.banner;
  } else {
    $("#bannerImg").style.display = "none";
  }

  // break banner
  const onBreak = metrics?.state === "break" && metrics?.break_until;
  $("#breakRibbon").hidden = !onBreak;
  if (onBreak) {
    $("#breakText").textContent = `Dr. on break  till ${fmtTime(metrics.break_until)}`;
  }

  // token numbers
  const nowServing = Number(metrics?.now_serving_token ?? 0);
  const yourToken = Number(booking?.token_number ?? 0);
  $("#nowToken").textContent = nowServing || "—";
  $("#yourToken").textContent = yourToken || "—";

  // progress bar (how far the queue has advanced relative to your token)
  let pct = 0;
  if (yourToken && nowServing) {
    pct = Math.max(0, Math.min(100, (nowServing / yourToken) * 100));
  }
  $("#progressFill").style.width = `${pct}%`;
  $("#progressDot").textContent = String(nowServing || 0);

  // service times
  $("#serviceStart").textContent = fmtTime(metrics?.service_started_at);
  const avgMin = metrics?.avg_service_seconds
    ? Math.round(Number(metrics.avg_service_seconds) / 60)
    : null;
  $("#avgService").textContent = avgMin ? `${avgMin} minutes` : "—";

  // booking info
  $("#custName").textContent = booking?.customer_name ?? "—";
  $("#assignedUser").textContent = booking?.assigned_user_name || booking?.assigned_user_id || "—";
  $("#bookingId").textContent = booking?.id ?? "—";
  $("#department").textContent = booking?.department ?? "—";
  $("#custPhone").textContent = booking?.customer_phone ?? "—";
  $("#bookingDate").textContent = fmtDateTime(booking?.created_at);
}

/* ---------- Reviews ---------- */
function initStars() {
  const stars = [...document.querySelectorAll(".star")];
  const paintStars = (n) => {
    stars.forEach((s, i) => s.classList.toggle("on", i < n));
  };
  stars.forEach((s) => {
    s.addEventListener("mouseenter", () => paintStars(Number(s.dataset.v)));
    s.addEventListener("mouseleave", () => paintStars(pickedStars));
    s.addEventListener("click", () => {
      pickedStars = Number(s.dataset.v);
      paintStars(pickedStars);
    });
  });
}

async function submitReview() {
  if (!lastPayload) return;
  const rating = pickedStars;
  const review = $("#reviewText").value.trim();
  const name = $("#reviewName").value.trim();

  if (!rating) {
    $("#reviewMsg").textContent = "Please select a star rating.";
    $("#reviewMsg").style.color = "var(--danger)";
    return;
  }

  const body = {
    org_id: ORG_ID,
    booking_id: BOOKING_ID || lastPayload?.booking?.id || null,
    rating,
    review,
    name
  };

  $("#submitBtn").disabled = true;
  $("#reviewMsg").textContent = "Submitting...";
  $("#reviewMsg").style.color = "var(--muted)";

  // Try a few likely endpoints so it works with your backend
  const endpoints = ["/reviews/create", "/reviews/add", "/reviews"];
  let ok = false, lastErr = null;

  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await r.json().catch(() => ({}));
      if (j.ok) { ok = true; break; }
      if (r.status === 404) continue;
      lastErr = j.error || `HTTP ${r.status}`;
    } catch (e) { lastErr = e.message; }
  }

  if (ok) {
    $("#reviewMsg").textContent = "Thanks! Your review has been recorded.";
    $("#reviewMsg").style.color = "var(--ok)";
    $("#submitBtn").disabled = true;
  } else {
    $("#reviewMsg").textContent = `Could not submit review. ${lastErr ? `(${lastErr})` : ""}`;
    $("#reviewMsg").style.color = "var(--danger)";
    $("#submitBtn").disabled = false;
  }
}

/* ---------- Init ---------- */
(async function init(){
  initStars();
  $("#submitBtn").addEventListener("click", submitReview);

  // first paint + polling
  try { await fetchStatus(); } catch(e){ console.error(e); }
  setInterval(fetchStatus, 15000);
})();

