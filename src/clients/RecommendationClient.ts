


export class RecommendationClient  {
    baseUrl:string;
    encodedCredentials:string;
    key:string;
    sourceId:string;
    axios;


    constructor(orgName: string, projectName: string, apiKey: string, sourceId: string,) {
        const domain = process.env.NODE_ENV === 'test'
            ? 'https://api.staging.intempt.com/v1'
            : 'https://api.intempt.com/v1' ;

        this.baseUrl = `${domain}/${orgName}/projects/${projectName}/feeds`;
        const [ username, password ] = apiKey.split('.');
       // this.encodedCredentials = btoa(`${username}:${password}`);
        this.encodedCredentials = Buffer.from(`${username}:${password}`).toString('base64');
        this.sourceId = sourceId;
        this.axios = require('axios').default;
        this.key = apiKey;
    }


    async recommendations(profileId: string,id:string,quantity:number,fields:string[], productId?:string){
        const url = `${this.baseUrl}/${id}/data?apiKey=${this.key}`;
        const body = {
            profileId,
            fields,
            sourceId:  this.sourceId,
            limit: quantity,
            productId: productId?.toString() ?? undefined,
        }

        try{
            const response = await this.axios.post(
                url,
                body,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        // Authorization: `Basic ${this.encodedCredentials}`,
                    },
                }
            )

            return response.data
        }
        catch(e:any){
            console.warn(e.message)
            throw Error(e.message)
        }


    }
}
