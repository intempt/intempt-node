import {HttpClient} from "./HttpClient";
import { randomUUID } from 'crypto';

export class TrackingClient extends HttpClient {
    constructor(orgName: string, projectName: string, apiKey: string, sourceId: number) {
        let featurePath: string = `sources/${sourceId}/track`
        super(orgName, projectName, apiKey, featurePath)
    }

    async record(name: string, profileId: string, userId?: string, accountId?: string, data?: object,
                 userAttributes?: object, accountAttributes?: object, anotherUserId?: string): Promise<void> {
        let eventId = randomUUID()
        let timestamp = Date.now()
        let requestBody: object = this.body(eventId, timestamp, name, profileId, userId, accountId,
            data, userAttributes, accountAttributes, anotherUserId)

        await this.send(requestBody)
    }

    body(eventId: string, timestamp: number, name: string, profileId?: string, userId?: string, accountId?: string,
         data?: object, userAttributes?: object, accountAttributes?: object, anotherUserId?: string): object {
        return {
            'track': [
                {
                    'name': name,
                    "payload": [
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
            ]
        }
    }
}