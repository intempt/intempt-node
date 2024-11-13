import {TrackingClient} from "./clients/TrackingClient";
import {ConsentsClient} from "./clients/ConsentsClient";
import {OptimizationClient} from "./clients/OptimizationClient";

export class SDK {
    trackingClient: TrackingClient;
    consentsClient: ConsentsClient;
    optimizationClient: OptimizationClient;

    constructor(orgName: string, projectName: string, apiKey: string, sourceId: string, time?: number, maxSize?: number) {
        if (!(orgName && projectName && apiKey && sourceId)) throw new Error("Incorrect configuration parameters")

        this.trackingClient = new TrackingClient(orgName, projectName, apiKey, sourceId, time, maxSize)
        this.consentsClient = new ConsentsClient(orgName, projectName, apiKey, sourceId)
        this.optimizationClient = new OptimizationClient(orgName, projectName, apiKey, sourceId)
    }

    async identify(profileId: string, userId: string, eventTitle?: string, userAttributes?: object) {
        if (eventTitle && this.verifyEventTitle(eventTitle) && userId && profileId) {
            await this.trackingClient.record(eventTitle, profileId, userId, undefined, undefined, userAttributes)
        } else if (userId && profileId) {
            await this.trackingClient.record('Identify', profileId, userId, undefined, undefined, undefined)
        } else {
            console.warn('identify request params are incorrect')
        }
    }

    async group(profileId: string, accountId: string, eventTitle?: string, accountAttributes?: object) {
        if (eventTitle && this.verifyEventTitle(eventTitle) && accountId && profileId) {
            await this.trackingClient.record(eventTitle, profileId, undefined, accountId, undefined, undefined, accountAttributes)
        } else if (accountId && profileId) {
            await this.trackingClient.record('Identify', profileId, undefined, accountId, undefined, undefined, undefined)
        } else {
            console.warn('group request params are incorrect')
        }
    }

    async track(profileId: string, eventTitle: string, data: object) {
        if (eventTitle && this.verifyEventTitle(eventTitle) && profileId) {
            await this.trackingClient.record(eventTitle, profileId, undefined, undefined, data)
        } else {
            console.warn('track request params are incorrect')
        }
    }

    async record(profileId: string, eventTitle: string, userId?: string, accountId?: string, data?: object,
           userAttributes?: object, accountAttributes?: object) {
        if (eventTitle && this.verifyEventTitle(eventTitle) && profileId) {
            await this.trackingClient.record(eventTitle, profileId, userId, accountId, data, userAttributes, accountAttributes)
        } else {
            console.warn('record request params are incorrect')
        }
    }

    async alias(profileId: string, userId: string, anotherUserId: string) {
        if (profileId && userId && anotherUserId) {
            await this.trackingClient.record('Identify', profileId, userId, undefined, undefined, undefined, undefined, anotherUserId)
        } else {
            console.warn('alias request params are incorrect')
        }
    }

    async consents(profileId: string, action: string, consentsExpirationTime?: string, email?: string, message?: string) {
        if (profileId && (action === 'accept' || action == 'reject')) {
            await this.consentsClient.record(action, profileId, undefined, consentsExpirationTime, email, message)
        } else {
            console.warn('consents request params are incorrect')
        }
    }

    async consent(profileId: string, action: string, category: string, consentsExpirationTime?: string,
                  email?: string, message?: string) {
        if (profileId && (action === 'accept' || action === 'reject') && category) {
            await this.consentsClient.record(action, profileId, category, consentsExpirationTime, email, message)
        } else {
            console.warn('consent request params are incorrect')
        }
    }

    async productAdd(profileId: string, productId:string, quantity:number){
        if(!productId || !quantity || quantity <= 0 || !profileId){
            return { error: true }
        }

        try{
            await this.trackingClient.productTrack('Added to cart', profileId, [
                {productId: productId, quantity: quantity}
            ])
        }
        catch (e:any){
            console.warn(`product request error: ${e.message}`)
            return { error: true }
        }
    }

    async productOrdered(profileId: string, products:{productId:String, quantity:number}[]){
        if (profileId && products && products.length > 0 && products.every(product => product.productId && product.quantity)) {
            try{
                await this.trackingClient.productTrack('Product ordered', profileId, products)
            }
            catch(e:any){
                console.warn(`product request error: ${e.message}`)
                return { error: true }
            }
        } else {
            console.warn('product ordered request params are incorrect')
            return { error: true }
        }
    }

    async productView(profileId: string, productId:String){
        if(!profileId || !productId){
            console.warn('product view request params are incorrect')
            return { error: true }
        }
        try{
            await this.trackingClient.productTrack('Product view', profileId, [
                {productId: productId}
            ])
        }
        catch(e:any){
            console.warn(`product request error: ${e.message}`)
            return { error: true }
        }

    }

    async choosePersonalizationsByGroups(profileId: string, groups?: string[]): Promise<any> {
        if (profileId) {
            return await this.optimizationClient.choose(profileId, 'personalization', groups)
        } else {
            console.warn('choose personalizations by groups request params are incorrect')
        }
    }

    async choosePersonalizationsByNames(profileId: string, names?: string[]): Promise<any> {
        if (profileId) {
            return await this.optimizationClient.choose(profileId, 'personalization', undefined, names)
        } else {
            console.warn('choose personalizations by names params are incorrect')
        }
    }

    async chooseExperimentsByGroups(profileId: string, groups?: string[]): Promise<any> {
        if (profileId) {
            return await this.optimizationClient.choose(profileId, 'experiment', groups)
        } else {
            console.warn('choose experiments by groups request params are incorrect')
        }
    }

    async chooseExperimentsByNames(profileId: string, names?: string[]): Promise<any> {
        if (profileId) {
            return await this.optimizationClient.choose(profileId, 'experiment', undefined, names)
        } else {
            console.warn('choose experiments by names params are incorrect')
        }
    }

    async optIn() {
        this.trackingClient.doNotTrack = false
    }

    async optOut() {
        this.trackingClient.doNotTrack = true
    }



    verifyEventTitle(eventTitle?: string): boolean {
        return eventTitle !== 'Identify'
    }
}
