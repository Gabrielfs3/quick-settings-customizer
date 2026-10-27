export class LatestValueWriter {
    constructor({intervalMs = 50, now, schedule, cancel, write, read, onValue, onError}) {
        this._intervalMs = intervalMs;
        this._now = now;
        this._schedule = schedule;
        this._cancel = cancel;
        this._write = write;
        this._read = read;
        this._onValue = onValue;
        this._onError = onError;
        this._pending = null;
        this._timer = 0;
        this._writing = false;
        this._disposed = false;
        this._generation = 0;
        this._lastValue = null;
        this._lastWriteAt = -Infinity;
    }

    setCurrent(value) {
        if (!this._disposed && !this._writing && this._pending === null)
            this._lastValue = value;
    }

    request(value) {
        if (this._disposed)
            return;
        if (this._pending === value)
            return;
        if (!this._writing && value === this._lastValue) {
            this._pending = null;
            this._cancelTimer();
            return;
        }
        this._pending = value;
        this._scheduleWrite();
    }

    _cancelTimer() {
        if (this._timer) {
            this._cancel(this._timer);
            this._timer = 0;
        }
    }

    _scheduleWrite() {
        if (this._disposed || this._writing || this._timer || this._pending === null)
            return;
        const elapsed = this._now() - this._lastWriteAt;
        const delay = Math.max(0, this._intervalMs - elapsed);
        this._timer = this._schedule(delay, () => {
            this._timer = 0;
            this._flush();
        });
    }

    async _flush() {
        if (this._disposed || this._writing || this._pending === null)
            return;
        const value = this._pending;
        this._pending = null;
        if (value === this._lastValue) {
            this._scheduleWrite();
            return;
        }

        const generation = this._generation;
        this._writing = true;
        this._lastWriteAt = this._now();
        try {
            await this._write(value);
            if (this._disposed || generation !== this._generation)
                return;
            const readBack = await this._read();
            if (!this._disposed && generation === this._generation) {
                this._lastValue = readBack;
                this._onValue(readBack);
            }
        } catch (error) {
            if (!this._disposed && generation === this._generation) {
                this._pending = null;
                this._onError(error);
            }
        } finally {
            this._writing = false;
            this._scheduleWrite();
        }
    }

    get writing() {
        return this._writing;
    }

    get hasPendingWork() {
        return this._writing || this._timer !== 0 || this._pending !== null;
    }

    cancelPending() {
        if (this._disposed)
            return;
        this._generation++;
        this._pending = null;
        this._cancelTimer();
    }

    dispose() {
        if (this._disposed)
            return;
        this.cancelPending();
        this._disposed = true;
    }
}
