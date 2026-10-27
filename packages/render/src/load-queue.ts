/** Bound an entire fetch/decode job, not just its network request. */
export class LoadQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly concurrency: number) {}

  run<T>(load: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.active++;
        const finish = (): void => {
          this.active--;
          this.waiting.shift()?.();
        };
        try { void load().then(resolve, reject).finally(finish); }
        catch (error) { reject(error); finish(); }
      };
      if (this.active < this.concurrency) start();
      else this.waiting.push(start);
    });
  }
}
