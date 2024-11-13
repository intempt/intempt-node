
export class HttpClient {
    url: string;
    axios;

    constructor(orgName: string, projectName: string, apiKey: string, featurePath: string) {
        const baseUrl = process.env.NODE_ENV === 'test'
            ? 'https://api.staging.intempt.com'
            : 'https://api.intempt.com' ;

        this.url = `${baseUrl}/v1/${orgName}/projects/${projectName}/${featurePath}?apiKey=${apiKey}`
        this.axios = require('axios').default
    }

    async send(requestBody: object): Promise<any> {
        try {
            return await this.axios.post(this.url, requestBody)
        } catch (error) {
            console.error(error)
            throw new Error('Failed to send request')
        }
    }
}
