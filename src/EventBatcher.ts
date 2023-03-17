import { SourcesApi } from './generated/push-source';

export class EventBatcher {
    private readonly batcher;

    public constructor(
        private orgName: string,
        private projectName: string,
        private sourceId: string,
        private sourcesApi: SourcesApi,
        settings?: {
            interval?: number, // sec
            maximum?: number,
        }
    ) {
        this.batcher = require('./batcher.js')(this.flush.bind(this), settings);
    }

    public addEvent(collName: string, event: {}) {
        const collectionName = collName.toLocaleLowerCase();
        if (!collectionName) {
            throw new Error("Collection name cannot be an empty string");
        }
        return this.batcher({ collName: collectionName, event: event })
    }

    private flush(a: NameAndEvent<any>[]) {
        const body = a.reduce((p, v) => {
            if (!p.hasOwnProperty(v.collName)) {
                p[v.collName] = [];
            }
            p[v.collName].push(v.event);
            return p;
        }, {} as { [k: string]: any[] });
        return this.sourcesApi.addDataItems({
            orgName: this.orgName,
            projectName: this.projectName,
            sourceId: this.sourceId,
            body: body
        });
    }
}

interface NameAndEvent<T> {
    collName: string
    event: T
}
