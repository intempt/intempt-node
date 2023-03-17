import * as IntemptSdk from '@intempt/sdk'

const orgName = 'orgName';
const projectName = 'projectName';
const sourceId = '46639.....912';
const experimentId = '153.....3db'; // uuid

const configuration = new IntemptSdk.Configuration({
    username: "****",
    password: "****",
});

const expApi = new IntemptSdk.CDPMetadata.ExperimentsApi(configuration);

await expApi.fetchExperiment({ orgName: orgName, projectName: projectName, experimentId: experimentId });

await expApi.updateExperiment({
    orgName: orgName,
    projectName: projectName,
    experimentId: experimentId,
    updateExperiment:
    {
        "title": "My detailed from node",
        "status": "ON",
        "schedule": {
            "timeZone": "Asia/Shanghai",
            "startDate": "2023-03-01T00:00",
            "endDate": "2023-03-09T23:59"
        },
        "showOn": ["https://web.shop/about"],
        "frequency": "ALWAYS",
        "targetAudience": null,
        "conversionGoal": "467205657650466816",
        "hypothesisTest": { "title": "t", "confidenceLevel": 95 }
    }
});

await expApi.createVariant({
    orgName: orgName,
    projectName: projectName,
    experimentId: experimentId,
    createVariant:
    {
        "title": "Red image",
        "trafficDistribution": 40,
        "variables": {
            "backgroundColor": "red"
        },
        "changesText": "{\"backgroundColor\": \"{{backgroundColor}}\"}"
    }
});

await expApi.deleteVariant({
    orgName: orgName,
    projectName: projectName,
    experimentId: experimentId,
    variantId: "0c2c09f8-d5fc-4a90-8dde-e0ec7fe8368e"
});

const target = {
    userIdentifier: 'bob@gmail.com',
    sessionId: 'sessionId' // optional
};

expApi.chooseVariant({
    orgName: orgName,
    projectName: projectName,
    experimentId: experimentId,
    chooseVariant: target
});
/**
 * example result would be: 
 * 
 * ```{"backgroundColor": "red"}```
 * 
 * or `null` as ne change required.
 */