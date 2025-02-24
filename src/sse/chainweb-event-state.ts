import {
  getRedisUnconfirmedEvents,
  getRedisConfirmedEvents,
  getRedisOrphanedEvents,
  setRedisUnconfirmedEvents,
  setRedisConfirmedEvents,
  setRedisOrphanedEvents,
} from './redis/index.js';
import { TransactionType, GenericData } from './types.js';
import Logger from './logger.js';

interface GetEventOptions {
  minHeight?: number;
  maxHeight?: number;
  limit?: number;
}

function heightSorter(a, b) {
  // sort high to low heights
  return a.height < b.height ? 1 : -1;
}

function presentEvents(sources, options) {
  const { minHeight, maxHeight, limit } = options;

  const filterPredicates = [];
  if (minHeight) {
    filterPredicates.push(event => event.height >= minHeight);
  }
  if (maxHeight) {
    filterPredicates.push(event => event.height <= maxHeight);
  }

  const output = sources.reduce((out, arr) => {
    if (filterPredicates.length) {
      // TODO if we have a limit set and a lot of data
      // we can save a bunch by returning up to limit from each arr
      arr = arr.filter(event => filterPredicates.every(pred => pred(event)));
    }
    return out.concat(arr);
  }, []);

  if (options.sort) {
    output.sort(heightSorter);
  }
  return options.limit ? output.slice(0, limit) : output;
}

export default class ChainwebEventServiceState {
  _type: TransactionType;
  _filter: string;
  logger: Logger;

  unconfirmed: GenericData[] = []
  confirmed: GenericData[] = []
  orphaned: GenericData[] = []

  constructor({ type, filter, logger }) {
    this._type = type;
    this._filter = filter;
    this.logger = logger;
  }

  async load() {
    const [
      unconfirmed,
      confirmed,
      orphaned,
    ] = await Promise.all([
      getRedisUnconfirmedEvents(this._type, this._filter),
      getRedisConfirmedEvents(this._type, this._filter),
      getRedisOrphanedEvents(this._type, this._filter),
    ]);
    this.unconfirmed = unconfirmed ?? [];
    this.confirmed = confirmed ?? [];
    this.orphaned = orphaned ?? [];
  }

  async save() {
    await Promise.all([
      setRedisConfirmedEvents(this._type, this._filter, this.confirmed),
      setRedisUnconfirmedEvents(this._type, this._filter, this.unconfirmed),
      setRedisOrphanedEvents(this._type, this._filter, this.orphaned),
    ]);
  }

  get summary() {
    return `confirmed=${this.confirmed.length} unconfirmed=${this.unconfirmed.length} orphaned=${this.orphaned.length}`;
  }

  getAllEvents({ minHeight, maxHeight, limit }: GetEventOptions = {}) {
    return presentEvents(
      [this.unconfirmed, this.confirmed, this.orphaned],
      { minHeight, maxHeight, limit, sort: true },
    );
  }

  getConfirmedEvents({ minHeight, maxHeight, limit }: GetEventOptions = {}) {
    return presentEvents(
      [this.confirmed],
      { minHeight, maxHeight, limit, sort: false },
    );
  }

  getOrphanedEvents({ minHeight, maxHeight, limit }: GetEventOptions = {}) {
    return presentEvents(
      [this.orphaned],
      { minHeight, maxHeight, limit, sort: false },
    );
  }

  /* add deduped and sorted */
  add(permanence, event) {
    const { height } = event;
    for(let idx = 0; idx < this[permanence].length; idx++) {
      const existing = this[permanence][idx];
      if (existing.height > height) {
        continue;
      }
      if (existing.height <= height) {
        // we can insert if we need to
        if (this._eventExists(event, this[permanence], idx)) {
          this.logger.warn(`Event ${event.requestKey} ${event.name} already in ${permanence}, not notifying`);
          return false;
        }
        this[permanence].splice(idx, 0, event);
        return true;
      }
    }
    // fallback; no existing events OR pushing oldest event
    this[permanence].push(event)
    return true;
  }

  remove(permanence, event) {
    const idx = this.unconfirmed.indexOf(event);
    if (idx === -1) {
      this.logger.warn(`Could not find event ${event.name} ${event.requestKey} from ${permanence} while trying to remove it from ${permanence}`);
      return false;
    }
    this[permanence].splice(idx, 1);
    return true;
  }

  _eventExists(needle, collection, startIdx=0) {
    if (!collection || !Array.isArray(collection)) {
      return this._eventExists(needle, this.unconfirmed) ||
        this._eventExists(needle, this.confirmed) ||
        this._eventExists(needle, this.orphaned);
    }
    const { height, requestKey, blockHash, meta: { id } } = needle;
    for(let idx = startIdx; idx < collection.length; idx++) {
      const event = collection[idx];
      if (event.meta.id !== id || event.height !== height || event.requestKey !== requestKey || event.blockHash !== blockHash) {
        // return early if basic stuff is different - save us a JSON.stringify
        continue;
      }
      if (event.height < height) {
        // we went past the needle event height, we can stop scanning
        // assumes collections are sorted(!)
        break;
      }
      if (event.meta.id === id) {
        return true;
      }
    }
    return false;
  }

}
