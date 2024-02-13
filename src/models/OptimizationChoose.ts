import type {
    Identification
} from './Identification'

export interface OptimizationChoose {
    identification: Identification;
    device?: string;
    sessionId?: string;
    url?: string;
}

export function requestBody(identification: Identification, url?: string, device?: string, sessionId?: string): OptimizationChoose {
    return {
        'identification': identification,
        'url': url,
        'device': device,
        'sessionId': sessionId
    }
}