
export class HttpClient {
    url: string;
    axios;

    constructor(orgName: string, projectName: string, apiKey: string, featurePath: string) {
        this.url = `https://api.intempt.com/v1/${orgName}/projects/${projectName}/${featurePath}?apiKey=${apiKey}`
        this.axios = require('axios').default
    }

    async send(requestBody: object): Promise<any> {
        try {
            return await this.axios.post(this.url, requestBody)
        } catch (error) {
            console.error(error)
        }
    }
}