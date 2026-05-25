export default defineNitroPlugin((nitroApp) => {
  const host = process.env.NITRO_HOST || process.env.HOST;

  if (host && !["127.0.0.1", "localhost"].includes(host)) {
    console.warn(
      "WARNING: server is listening on a non-localhost host without authentication:",
      host,
    );
  }
});
