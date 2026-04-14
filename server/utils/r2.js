const { S3Client } = require("@aws-sdk/client-s3");

const accountId  = process.env.CLOUDFLARE_R2_ACCOUNT_ID  || "";
const bucketName = process.env.CLOUDFLARE_R2_BUCKET       || "swft-photos";
const publicUrl  = (process.env.CLOUDFLARE_R2_PUBLIC_URL  || "").replace(/\/$/, "");

if (!accountId) {
  console.warn("[r2] CLOUDFLARE_R2_ACCOUNT_ID not set — photo uploads will fail");
}

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.CLOUDFLARE_R2_ACCESS_KEY_ID     || "",
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || "",
  },
});

module.exports = { r2, bucketName, publicUrl };
