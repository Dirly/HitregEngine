import { propPolicy } from "./_prop-curation.mts";
const pol = propPolicy("projects", "otown2-lab");
for (const id of process.argv.slice(2)) { const w = pol.excluded(id); console.log(w ? `NO ${id} (${w.note ?? ""})` : `ok ${id}`); }
