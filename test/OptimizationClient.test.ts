import {expect, jest, test} from "@jest/globals";
import {ApiResponse, Configuration, OptimizationClient} from "../src";

const configuration = new Configuration({
    username: 'fcb6406c903e4696b16b16aec9d83ef0',
    password: '3ecf778ad4cb4aba8ba432cbaef8dd79',
    basePath: 'https://api.intempt.com',
});

const optimizationClient = new OptimizationClient(
    configuration
);

const requestParameters = {
    identification: {
        userId: 'John 100034 Snow/Stark'
    },
    url: 'https://intempt.com'
};

test('max 3 with 4 message', async () => {
    const rows = await optimizationClient.chooseRows('test-roman-3', 'test-intempt-data', requestParameters);
    rows
});



