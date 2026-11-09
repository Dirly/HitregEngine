/** Three r185 can dispose a queued render object before its first binding upload.
 * Its deleteForRender nevertheless decrements shared bind-group references.
 * Only initialized objects own such references; an uninitialized disposal must
 * not allocate getBindings() or destroy another object's live uniform buffers.
 */
export interface BindingManagerLike {
  get(object: unknown): { initialized?: boolean };
  delete(object: unknown): unknown;
  deleteForRender(object: unknown): void;
}

export function guardUninitializedBindingDisposal(manager: Partial<BindingManagerLike> | undefined): void {
  if (!manager || typeof manager.get !== "function" || typeof manager.delete !== "function" || typeof manager.deleteForRender !== "function") return;
  const original = manager.deleteForRender;
  const bindings = manager as BindingManagerLike;
  bindings.deleteForRender = function (object) {
    if (this.get(object).initialized !== true) {
      this.delete(object);
      return;
    }
    original.call(this, object);
  };
}
