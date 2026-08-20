export class StoppedError extends Error {
  constructor() {
    super("Stopped by user.");
    this.name = "StoppedError";
  }
}
