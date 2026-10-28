import type {ReviewProp} from './prop-review.js';

export interface ReviewFilters {
  query: string;
  kind: string;
  collection: string;
  category: string;
  culture: string;
  state: string;
}

/** Trash is a separate view; structural assets do not crowd the default prop grid. */
export function filterReviewProps(rows: ReviewProp[], filters: ReviewFilters): ReviewProp[] {
  const {query,kind,collection,category,culture,state}=filters;
  const words=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return rows.filter(p=>{
    if(state==='trash' ? !p.trashed : p.trashed)return false;
    if(state!=='trash'&&kind!=='all'&&(p.kind??'prop')!==kind)return false;
    if(collection&&p.collection!==collection||category&&p.category!==category||culture&&!p.cultures.includes(culture))return false;
    if(state==='excluded'&&!p.excluded||state==='allowed'&&p.excluded||state==='review'&&!p.needsReview||state==='kept'&&(p.excluded||p.needsReview||p.decision?.use!=='allow'))return false;
    return words.every(w=>[p.id,p.name,p.description,p.category,...p.rooms,...p.cultures].join(' ').toLowerCase().includes(w));
  });
}
