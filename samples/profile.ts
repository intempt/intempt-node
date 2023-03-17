import * as IntemptSdk from '@intempt/sdk'
import { randomUUID } from 'crypto';


const orgName = 'orgName';
const projectName = 'projectName';
const sourceId = '46639.....912';

const configuration = new IntemptSdk.Configuration({
    accessToken: '', // bearer token 
});
const sourcesApi = new IntemptSdk.CDPMetadata.SourcesApi(configuration);

const eventRecorder = IntemptSdk.EventRecorder.WithEventBatcher(
    orgName,
    projectName,
    sourceId,
    sourcesApi,
    { maximum: 100, interval: 10 });

await eventRecorder
    .trackConsents(
        "bob",
        [
            {
                regulation: 'GDPR',
                purpose: 'advertising',
                consented: false
            }, {
                regulation: 'CCPA',
                purpose: 'advertising',
                consented: false
            }
        ]);

