import { mountPropReview, type PropReviewHost, type ReviewCatalog, type ReviewProp } from '@hitreg/editor';
import { PropPreviewRenderer } from './prop-review-preview.js';
import './prop-review.css';
const preview = new PropPreviewRenderer();
async function request<T>(url: string, options?: RequestInit): Promise<T> { const response = await fetch(url, options), data = await response.json(); if (!response.ok)
    throw Error(data.error ?? `Request failed (${response.status})`); return data as T; }
const route = (project: string) => `/__hitreg/prop-review?project=${encodeURIComponent(project)}`;
const host: PropReviewHost = {
    initialProject: new URLSearchParams(location.search).get('project') ?? 'world-kit',
    load: project => request<ReviewCatalog>(route(project)),
    save: (project, row, use, note, revision) => request(route(project), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: row.id, use, note, revision, hash: row.hash }) }),
    thumbnail: (project, row: ReviewProp, signal) => preview.thumbnail(project, row, signal),
    preview: (project, row, canvas) => preview.live(project, row, canvas),
};
mountPropReview(document.getElementById('prop-review')!, host);
