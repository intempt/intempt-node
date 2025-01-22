import {test, describe, it, expect} from "@jest/globals";
import {SDK} from "../src";
import { randomUUID } from 'crypto';

const intempt: SDK = new SDK(
    'intempt2',
    'intempt2_project',
    '43945a1e4daa4077a5dba16c920b475e.6645fee5114c4cd09a725232c512b52b',
    '684508596718616576'
)


describe('Intempt SDK Method Tests', () => {
    it('should opt in the user', async () => {
        await intempt.optIn();

        expect(intempt.trackingClient.doNotTrack).toBe(false);

    });

    it('should invoke productAdd without error', async () => {
        const res = await intempt.productAdd(`${randomUUID()}`, `${randomUUID()}`, 1)
        expect(!!res?.error).toBe(false);
    })

    it('should invoke productAdd with error', async () => {
        const res = await intempt.productAdd("", `${randomUUID()}`, 0)
        expect(!!res?.error).toBe(true);
    })

    it('should invoke productView without error', async () => {
        const res = await intempt.productView(`${randomUUID()}`, `${randomUUID()}`)
        expect(!!res?.error).toBe(false);
    })

    it('should invoke productView with error', async () => {
        const res = await intempt.productView("", `${randomUUID()}`)
        expect(!!res?.error).toBe(true);
    })

    it('should invoke productOrdered without error', async () => {
        const res = await intempt.productOrdered(`${randomUUID()}`, [{productId: `${randomUUID()}`, quantity: 1}])
        expect(!!res?.error).toBe(false);
    })

    it('should invoke productOrdered without error', async () => {
        const items = [{productId: `${randomUUID()}`, quantity: 1}, {productId: `${randomUUID()}`, count: 1}]
        const res = await intempt.productOrdered("", items as any)
        expect(!!res?.error).toBe(true);
    })

    it('should opt out the user', async () => {
        await intempt.optOut();

        expect(intempt.trackingClient.doNotTrack).toBe(true);
    });

    it('should return recommendations', async () => {
        const id = '848';
        const quantity= 5;
        const fields = ["id", "price", "title"]

        const res = await intempt.recommendation(
            randomUUID(),
            id,quantity,fields
        )

        expect(!!res?.error).toBe(false);
    });
})


// test('test', async () => {
    // await intempt.optIn()
    // await intempt.identify("john-snow-profile", "")
   // await intempt.identify("john-snow-profile", "John Snow")
    // await intempt.identify("john-snow-profile", "John Snow", "identify-user")
    // await intempt.identify("john-snow-profile", "John Snow", "identify-user", {"location": "Winterfell"})

    // await intempt.group("john-snow-profile", "Stark")
    // await intempt.group("john-snow-profile", "Stark", "identify-account", {"domain": "starks.com"})
    //
    // await intempt.optOut()
    // await intempt.track("john-snow-profile", "purchase", {"total_price": 700.0})
    // await intempt.optIn()
    // await intempt.track("john-snow-profile", "purchase", {"total_price": 700.0})
    // await intempt.track("john-snow-profile", "", {"total_price": 700.0})
    //
    // await intempt.record("john-snow-profile", "battle", "John Snow", "Stark",
    //     {"house_first": "Stark", "house_second": "Lannister", "winner": "Stark"},
    //     {"enemies_killed": 74}, {"battle_status": "victory"})

    // await intempt.alias("john-snow-profile", "John Snow", "Aegon Targaryen")
    //
    // await intempt.consents("john-snow-profile", "accept")
    // await intempt.consents("john-snow-profile", "")
    // await intempt.consent("john-snow-profile", "accept", "notifications",
    //     "1711705256000", undefined, "Are you sure?!")

    // console.log(await intempt.chooseExperimentsByGroups("john-snow-profile", []))
    // console.log(await intempt.chooseExperimentsByGroups("john-snow-profile"))
    // console.log(await intempt.chooseExperimentsByGroups("john-snow-profile", ['test-2']))
    // console.log(await intempt.chooseExperimentsByNames("john-snow-profile", ['test-1']))

    // await intempt.identify("john-snow-profile", "John Snow", "identify-user")
    // await intempt.identify("john-snow-profile", "John Snow", "identify-user")
    // await intempt.identify("john-snow-profile", "John Snow", "identify-user")
    //
    // await intempt.consents("john-snow-profile", "accept")
    // await intempt.consents("john-snow-profile", "accept")
    // await intempt.consents("john-snow-profile", "accept")
    // await intempt.consents("john-snow-profile", "accept")
    // await intempt.consents("john-snow-profile", "accept")
// });
