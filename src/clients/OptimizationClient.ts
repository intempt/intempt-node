import * as runtime from '../runtime';
import type {
    OptimizationChoose
} from '../models/OptimizationChoose'

export class OptimizationClient extends runtime.BaseAPI {
    async chooseRows(orgName: string, projectName: string, requestBody: OptimizationChoose): Promise<runtime.ApiResponse<any>> {
        if (orgName === null || orgName === undefined) {
            throw new runtime.RequiredError('orgName','Required parameter requestParameters.orgName was null or undefined when calling chooseExperience.');
        }

        if (projectName === null || projectName === undefined) {
            throw new runtime.RequiredError('projectName','Required parameter requestParameters.projectName was null or undefined when calling chooseExperience.');
        }

        if (requestBody === null || requestBody === undefined) {
            throw new runtime.RequiredError('chooseExperience','Required parameter requestParameters.chooseExperience was null or undefined when calling chooseExperience.');
        }

        const queryParameters: any = {};

        const headerParameters: runtime.HTTPHeaders = {};

        headerParameters['Content-Type'] = 'application/json';

        if (this.configuration && this.configuration.accessToken) {
            // oauth required
            headerParameters["Authorization"] = await this.configuration.accessToken("auth0", []);
        }

        if (this.configuration && (this.configuration.username !== undefined || this.configuration.password !== undefined)) {
            headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
        }
        if (this.configuration && this.configuration.accessToken) {
            const token = this.configuration.accessToken;
            const tokenString = await token("bearerAuth", []);

            if (tokenString) {
                headerParameters["Authorization"] = `Bearer ${tokenString}`;
            }
        }
        //https://api.intempt.com/v1/test-roman-3/projects/test-intempt-data/personalization/campaigns/1073/experience-choose
        const response = await this.request({
            path: `/v1/{orgName}/projects/{projectName}/optimization/choose-web`.replace(`{${"orgName"}}`, encodeURIComponent(String(orgName))).replace(`{${"projectName"}}`, encodeURIComponent(String(projectName))),
            method: 'POST',
            headers: headerParameters,
            query: queryParameters,
            body: requestBody,
        });

        console.debug("chooseExperienceRaw - path - ", `/v1/{orgName}/projects/{projectName}/optimization/choose-web`.replace(`{${"orgName"}}`, encodeURIComponent(String(orgName))).replace(`{${"projectName"}}`, encodeURIComponent(String(projectName))))
        console.debug("chooseExperienceRaw - body - ", requestBody)

        return new runtime.TextApiResponse(response) as any;
    }
}