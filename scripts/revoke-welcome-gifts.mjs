#!/usr/bin/env node
/**
 * Otomatik hoşgeldin hediyesiyle (welcome.*) verilmiş premium abonelikleri iptal eder.
 *
 * DOKUNMAZ:
 *   • App Store abonelikleri (com.dynamicisland.premium.*) — deneme süresi dahil
 *   • Panelden gönderilen manuel hediyeler (gift.*)
 *   • Zaten pasif olan kayıtlar
 *
 * Kullanım:
 *   FIREBASE_SERVICE_ACCOUNT='<service account JSON>' node scripts/revoke-welcome-gifts.mjs --dry-run
 *   FIREBASE_SERVICE_ACCOUNT='<service account JSON>' node scripts/revoke-welcome-gifts.mjs
 *
 * Railway'de:  railway run node scripts/revoke-welcome-gifts.mjs --dry-run
 */

import { createSign } from "node:crypto";

const DRY_RUN = process.argv.includes("--dry-run");

// Bu ön eklerle başlayan abonelikler iptal edilir
const REVOKE_PREFIXES = ["welcome."];

// Bu ön eklerle başlayanlara asla dokunulmaz (ek güvenlik)
const PROTECTED_PREFIXES = ["com.dynamicisland.premium", "gift."];

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT tanımlı değil.");
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT geçerli JSON değil.");
    process.exit(1);
  }
}

const sa = serviceAccount();
const BASE = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const jwt = `${unsigned}.${signer.sign(sa.private_key, "base64url")}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent(
      "urn:ietf:params:oauth:grant-type:jwt-bearer"
    )}&assertion=${jwt}`
  });
  if (!res.ok) throw new Error(`Google token alınamadı: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function* allUsers(token) {
  let pageToken = "";
  do {
    const u = new URL(`${BASE}/users`);
    u.searchParams.set("pageSize", "300");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Firestore okunamadı: ${await res.text()}`);
    const json = await res.json();
    for (const doc of json.documents || []) yield doc;
    pageToken = json.nextPageToken || "";
  } while (pageToken);
}

async function revoke(token, docID, sub) {
  const fields = {
    subscription: {
      mapValue: {
        fields: {
          ...sub,
          isActive: { booleanValue: false },
          revokedAt: { timestampValue: new Date().toISOString() },
          revokedReason: { stringValue: "auto welcome gift removed" }
        }
      }
    }
  };
  const res = await fetch(
    `${BASE}/users/${encodeURIComponent(docID)}?updateMask.fieldPaths=subscription`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ fields })
    }
  );
  if (!res.ok) throw new Error(await res.text());
}

async function main() {
  const token = await accessToken();

  let scanned = 0;
  let revoked = 0;
  let protectedCount = 0;
  const failures = [];

  console.log(DRY_RUN ? "🔍 DRY RUN — hiçbir şey yazılmayacak\n" : "✍️  Yazma modu\n");

  for await (const doc of allUsers(token)) {
    scanned += 1;
    const docID = doc.name.split("/").pop();
    const sub = doc.fields?.subscription?.mapValue?.fields;
    if (!sub) continue;

    const productID = sub.productID?.stringValue || "";
    const isActive = sub.isActive?.booleanValue === true;
    if (!isActive) continue;

    if (PROTECTED_PREFIXES.some((p) => productID.startsWith(p))) {
      protectedCount += 1;
      continue;
    }
    if (!REVOKE_PREFIXES.some((p) => productID.startsWith(p))) {
      protectedCount += 1;
      continue;
    }

    console.log(`  ↳ ${docID}  (${productID})`);
    revoked += 1;
    if (DRY_RUN) continue;

    try {
      await revoke(token, docID, sub);
    } catch (error) {
      failures.push({ docID, error: error.message });
    }
  }

  console.log("\n──────── ÖZET ────────");
  console.log(`Taranan kullanıcı        : ${scanned}`);
  console.log(`İptal edilen (welcome.*) : ${revoked}${DRY_RUN ? " (dry run)" : ""}`);
  console.log(`Korunan aktif abonelik   : ${protectedCount}`);
  if (failures.length) {
    console.log(`\n⚠️  Başarısız: ${failures.length}`);
    for (const f of failures) console.log(`   ${f.docID}: ${f.error}`);
  }
}

main().catch((error) => {
  console.error("❌", error.message);
  process.exit(1);
});
