import {HttpClient} from "./HttpClient";

export class ConsentsClient extends HttpClient {
    sourceId: number;

    constructor(orgName: string, projectName: string, apiKey: string, sourceId: number) {
        let featurePath: string = `consents/data`
        super(orgName, projectName, apiKey, featurePath)
        this.sourceId = sourceId
    }

    async record(action: string, profileId: string, category?: string, validUntil?: string,
                 email?: string, message?: string): Promise<void> {
        let timestamp = Date.now()
        let requestBody: object = this.body(timestamp, action, profileId, category, validUntil, email, message)

        await this.send(requestBody)
    }

    body(timestamp: number, action: string, profileId: string, category?: string, validUntil?: string,
         email?: string, message?: string): object {
        return {
            'action': action,
            'category': category,
            'timestamp': timestamp,
            'profileId': profileId,
            'sourceId': this.sourceId,
            'validUntil': validUntil === undefined ? 'unlimited' : validUntil,
            'source': 'NodeJs tracker',
            'email': email,
            'message': message,
        }
    }
}