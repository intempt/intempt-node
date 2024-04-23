import {HttpClient} from "./HttpClient";
import { randomUUID } from 'crypto';

export class TrackingClient extends HttpClient {
    tracks: object[];
    timeoutId: any;
    time?: number;
    maxSize?: number;
    doNotTrack: boolean;


    constructor(orgName: string, projectName: string, apiKey: string, sourceId: string, time?: number, maxSize?: number) {
        let featurePath: string = `sources/${sourceId}/track`
        super(orgName, projectName, apiKey, featurePath)
        this.tracks = []
        this.time = time
        this.maxSize = maxSize
        this.doNotTrack = false
    }

    async record(name: string, profileId: string, userId?: string, accountId?: string, data?: object,
                 userAttributes?: object, accountAttributes?: object, anotherUserId?: string): Promise<void> {
        if (this.doNotTrack) return

        let eventId = randomUUID()
        let timestamp = Date.now()
        this.tracks.push(this.single(eventId, timestamp, name, profileId, userId, accountId,
            data, userAttributes, accountAttributes, anotherUserId))

        if (this.maxSize === undefined && this.time === undefined) {
            return await this.recordTracks()
        }

        if (this.time !== undefined && this.timeoutId === undefined) {
            this.timeoutId = setTimeout(() => {
                this.recordTracks()
                this.tearDown()
            }, this.time);
        }

        if (this.maxSize !== undefined && this.tracks.length === this.maxSize) {
            await this.recordTracks()
            clearTimeout(this.timeoutId)
            this.tearDown()
        }
    }

    async recordTracks(): Promise<void> {
        let requestBody: object = this.body(this.tracks)
        await this.send(requestBody)
    }

    body(a: object[]) {
        return {
            'track': a
        }
    }

    single(eventId: string, timestamp: number, name: string, profileId?: string, userId?: string, accountId?: string,
           data?: object, userAttributes?: object, accountAttributes?: object, anotherUserId?: string): object {
        return {
            'name': name,
            'payload': [
                {
                    'eventId': eventId,
                    'timestamp': timestamp,
                    'profileId': profileId,
                    'userId': userId,
                    'accountId': accountId,
                    'data': data,
                    'userAttributes': userAttributes,
                    'accountAttributes': accountAttributes,
                    'anotherUserId': anotherUserId
                }
            ]
        }
    }

    tearDown() {
        this.tracks = []
        this.timeoutId = undefined
    }
}