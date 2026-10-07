// Settings → Storage and Tidy up (day 358, docs/reviews/2026-09-26-day-358.md). The meter counts
// every file (worker/lib/storage.ts storageReport): green, yellow at 70%, red at 90% of the free
// 10 GB, what takes the space and each kind's rule, Measure now, and the fix guide. Tidy up (on
// by default) archives finished things at the ages listed here; it never deletes.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { StorageView } from "@shared/types";
import { gbWords } from "@shared/bytes";
import { get, patch, post } from "../lib/api";
import { ago } from "../lib/format";
import { Card, Dot, Skeleton, Switch, useLoad, useToast } from "./ui";

interface StorageAnswer extends StorageView {
  rules: {
    tidy: { dumpArchiveDays: number; dealArchiveDays: number; quietDealArchiveDays: number; briefArchiveDays: number; failedVoiceArchiveDays: number; unusedVoiceArchiveDays: number };
    files: { postedClipDays: number; draftDays: number; warnDays: number; keepDays: number };
    storage: { yellowAt: number; redAt: number };
  };
}

const WORD = { green: "Plenty of room", yellow: "Filling up", red: "Almost full" } as const;

export function StorageSection({ owner }: { owner: boolean }) {
  const toast = useToast();
  const s = useLoad(() => get<StorageAnswer>("/api/archive/storage"));
  const [measuring, setMeasuring] = useState(false);

  async function measure() {
    setMeasuring(true);
    try {
      const r = await post<StorageView>("/api/archive/storage/measure");
      s.setData((d) => (d ? { ...d, ...r } : d));
      toast.ok(`Measured: ${r.line}.`);
    } catch (e) {
      toast.bad(e);
    } finally {
      setMeasuring(false);
    }
  }
  async function setTidy(on: boolean) {
    try {
      await patch("/api/archive/tidy", { on });
      s.setData((d) => (d ? { ...d, tidy_on: on } : d));
      toast.ok(on ? "Tidy up is on." : "Tidy up is off. Nothing is archived on its own now.");
    } catch (e) {
      toast.bad(e);
    }
  }

  // Home's "See what takes the space" and the Storage light's link land here (/settings#storage).
  useEffect(() => {
    if (s.data && window.location.hash === "#storage") document.getElementById("storage")?.scrollIntoView({ block: "start" });
  }, [s.data]);

  if (!s.data) return <Skeleton lines={3} />;
  const d = s.data;
  const pct = Math.min(100, Math.round((d.used_bytes / d.limit_bytes) * 100));
  const t = d.rules.tidy;
  const f = d.rules.files;
  return (
    <>
      <section className="section" id="storage" aria-label="Storage">
        <div className="section-head">
          <h2>Storage</h2>
          <button className="btn quiet small" onClick={measure} disabled={measuring}>
            {measuring ? "Measuring…" : "Measure now"}
          </button>
        </div>
        <Card>
          <div className="storage-head">
            <Dot light={d.light} />
            <strong>{WORD[d.light]}</strong>
            <span className="nums">{d.line}</span>
          </div>
          <div className={`meter storage-meter ${d.light === "green" ? "ok" : d.light === "yellow" ? "warn" : "bad"}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Storage ${pct}% used`}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="hint">
            Free storage is 10 GB. Yellow at {Math.round(d.rules.storage.yellowAt * 100)}%, red at {Math.round(d.rules.storage.redAt * 100)}%. Every day the dashboard clears files by the rules below, and if it is still over {gbWords(d.budget_bytes)} it clears the oldest originals, rejected clips and posted clips first; never a clip waiting to post, a media kit clip, or a draft without a warning. {d.measured_at ? `Last measured ${ago(d.measured_at)}.` : ""}{" "}
            {d.light !== "green" ? <Link to="/help/storage-almost-full">What to do when it fills up</Link> : null}
          </div>
          <ul className="storage-kinds">
            {d.kinds
              .filter((k) => k.bytes > 0 || k.count > 0)
              .map((k) => (
                <li key={k.key} data-storage-kind={k.key}>
                  <span className="grow">
                    <strong>{k.label}</strong>
                    {k.count ? <span className="hint nums"> · {k.count}</span> : null}
                    <span className="hint storage-rule">{k.rule}</span>
                  </span>
                  <span className="nums">{gbWords(k.bytes)}</span>
                </li>
              ))}
          </ul>
        </Card>
      </section>

      <section className="section" id="tidy" aria-label="Tidy up">
        <h2>Tidy up</h2>
        <Card>
          <Switch checked={d.tidy_on} onChange={(v) => owner && setTidy(v)} label="Tidy up automatically" hint="Moves finished things to Archived so your lists stay short. Nothing is deleted: Show archived brings any of it back." />
          <ul className="tidy-rules">
            <li>Dumps you finished: archived after {t.dumpArchiveDays} days</li>
            <li>Deals that are paid, done, declined or lost: after {t.dealArchiveDays} days</li>
            <li>An open deal with nothing happening (not one you invoiced): after {t.quietDealArchiveDays} days</li>
            <li>Research briefs a newer one replaced: after {t.briefArchiveDays} days</li>
            <li>Voice overs that failed: after {t.failedVoiceArchiveDays} days; never used: after {t.unusedVoiceArchiveDays} days</li>
          </ul>
          <div className="hint">
            Files (always on, to stay inside the free storage): posted clips {f.postedClipDays} days after posting (not media kit clips); clips you never reviewed {f.draftDays} days after they were made, with a warning on Home {f.warnDays} days before and a Keep button ({f.keepDays} more days).
          </div>
        </Card>
      </section>
    </>
  );
}
