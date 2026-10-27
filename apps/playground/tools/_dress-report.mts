/**
 * Where `dress check` keeps a plan's machine report: `<project>/authoring/dressing/reports/<plan file name>.report.json`,
 * never beside the plan (a plans dir or a place-build job's dressing dir holds plans only). The project is the nearest
 * folder above the plan with a project.json; a plan outside any project (a trial in a scratch dir) keeps it beside itself.
 * Readers use `readableReportFile`, which also finds a report an older dress wrote beside its plan.
 */
import fs from "node:fs";
import path from "node:path";

export function projectOfPlan(planFile: string): string | undefined {
  let dir = path.dirname(path.resolve(planFile));
  for (;;) {
    if (fs.existsSync(path.join(dir, "project.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function dressReportFile(planFile: string): string {
  const proj = projectOfPlan(planFile), base = path.basename(planFile).replace(/\.json$/, ".report.json");
  return proj ? path.join(proj, "authoring", "dressing", "reports", base) : planFile.replace(/\.json$/, ".report.json");
}

/** The report to read: the reports dir's, else a legacy one beside the plan; undefined when there is none. */
export function readableReportFile(planFile: string): string | undefined {
  for (const f of [dressReportFile(planFile), planFile.replace(/\.json$/, ".report.json")]) if (fs.existsSync(f)) return f;
  return undefined;
}
