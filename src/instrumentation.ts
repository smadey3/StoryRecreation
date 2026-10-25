// Runs once when the server starts.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Nightly backups to the family's own cloud storage, when it's been set up.
    const { startBackupSchedule } = await import("./lib/server/offsite");
    startBackupSchedule();
    // Classic covers kept with their books, for books shelved before covers were kept.
    const { keepMissingCoversSoon } = await import("./lib/server/covers");
    keepMissingCoversSoon();
    // Stories a restart (an update, say) stopped midway carry on, keeping the pages already voiced.
    const { resumeLostStoriesSoon } = await import("./lib/server/jobs");
    resumeLostStoriesSoon();
    // The illustrator carries on with any pictures a restart (an update, say) stopped midway.
    const { resumeLostArtSoon } = await import("./lib/server/art");
    resumeLostArtSoon();
    // Pictures are priced from what they've really cost lately.
    const { refreshPictureCost } = await import("./lib/server/spending");
    refreshPictureCost();
    // Dreamed-up books nobody named take their first story's title (books made before they were named so).
    const { nameUnnamedBooks } = await import("./lib/server/db");
    nameUnnamedBooks();
    // Photos for a book that was never finished are let go after a day.
    const { clearOldUploadsDaily } = await import("./lib/server/uploads");
    clearOldUploadsDaily();
  }
}
