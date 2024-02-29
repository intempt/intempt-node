import {HttpClient} from "./HttpClient";

export class OptimizationClient extends HttpClient {
    sourceId: number;

    constructor(orgName: string, projectName: string, apiKey: string, sourceId: number) {
        let featurePath: string = `optimization/choose-api`
        super(orgName, projectName, apiKey, featurePath)
        this.sourceId = sourceId
    }

    async choose(profileId: string, optimizationType?: string, groups?: string[], names?: string[]): Promise<any> {
        let requestBody: object = this.body(profileId, optimizationType, groups, names)
        let response = await this.send(requestBody)
        return response.data.choices
    }

    body(profileId: string, optimizationType?: string, groups?: string[], names?: string[]): object {
        return {
            'identification': {
                'profileId': profileId,
                'sourceId': this.sourceId
            },
            'groups': groups,
            'names': names,
            'optimizationType': optimizationType,
            'device': "all"
        }
    }
}