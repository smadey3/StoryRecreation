import { pageCtx } from "@/lib/server/auth";
import { listDesignedVoices, listFamilyVoices, listKeepsakes, listProfiles, listTurnedDown } from "@/lib/server/db";
import { appStatus, config } from "@/lib/server/config";
import { familyBackup } from "@/lib/server/backup";
import { backupStatus } from "@/lib/server/offsite";
import { alertsStatus } from "@/lib/server/alerts";
import { spendingSummary } from "@/lib/server/spending";
import { GrownupsView } from "./GrownupsView";

export const metadata = { title: "Grown-ups' corner" };

export default async function GrownupsPage() {
  const ctx = await pageCtx();
  return (
    <main className="page page-narrow">
      <GrownupsView
        familyName={ctx.household.name}
        email={ctx.household.email}
        unlocked={ctx.grownup}
        unlockedUntil={ctx.household.pin_hash ? ctx.session.grownup_until : null}
        pinSet={Boolean(ctx.household.pin_hash)}
        profiles={listProfiles(ctx.household.id)}
        designed={listDesignedVoices(ctx.household.id)}
        keepsakes={listKeepsakes(ctx.household.id)}
        familyVoices={listFamilyVoices(ctx.household.id)}
        backup={ctx.grownup ? familyBackup(ctx.household.id).summary : null}
        backups={ctx.grownup ? backupStatus() : null}
        alerts={ctx.grownup ? alertsStatus() : null}
        spending={ctx.grownup ? spendingSummary(ctx.household.id) : null}
        turnedDown={ctx.grownup ? listTurnedDown(ctx.household.id) : null}
        status={appStatus()}
        driveKey={config.googleDriveKey ?? null}
      />
    </main>
  );
}
