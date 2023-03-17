import { SourcesApi } from './generated/push-source';
import { ConsentRegulation } from './generated/cdp-metadata';
import { EventBatcher } from './EventBatcher';

export class EventRecorder {
    static WithEventBatcher(
        orgName: string,
        projectName: string,
        sourceId: string,
        sourcesApi: SourcesApi,
        settings?: {
            interval?: number, // sec
            maximum?: number,
        },
    ): EventRecorder {
        return new EventRecorder(new EventBatcher(orgName, projectName, sourceId, sourcesApi, settings));
    }
    constructor(
        private readonly eventBatcher: EventBatcher
    ) { }

    /**
     * recordEvent
     */
    public addEvent(name: string, data: {} | {}[]): Promise<void> {
        const collectionName = name.toLocaleLowerCase();
        if (!collectionName) {
            throw new Error("Collection name cannot be an empty string");
        }
        return Array.isArray(data)
            ? Promise.all(data.map(d => this.eventBatcher.addEvent(name, d))).then()
            : this.eventBatcher.addEvent(name, data);
    }

    public profile(profileId: string, user_identifier: string, account_identifier?: string): Promise<void> {
        return this.addEvent(
            'profile',
            {
                profileId: profileId,
                user_identifier: user_identifier,
                account_identifier: account_identifier ?? null
            }
        );
    }

    /**
     *
     * @param consents example:
     * ```
     * {
     *   regulation: 'GDPR', // as ConsentRegulation
     *   purpose: 'advertising',
     *   consented: true
     * }
     * ```
     */
    public trackConsents(
        profileId: string,
        consents: {
            regulation: ConsentRegulation,
            purpose: string,
            consented: boolean,
        }[],
        timestamp_unixtime_ms?: number,
        eventId?: string,
        document?: string,
        location?: string,
        hardware_id?: string,
    ) {
        return this.addEvent('consents', {
            eventId: eventId ?? profileId,
            profileId: profileId,
            consents: consents,
            timestamp_unixtime_ms: Number.isFinite(timestamp_unixtime_ms) ? timestamp_unixtime_ms : Math.floor(Date.now() / 1000),
            document: document,
            location: location,
            hardware_id: hardware_id,
        });
    }
}
