import type {
    Identification
} from './Identification'

export interface OptimizationChoose {
    identification: Identification;
    device?: string;
    sessionId?: string;
    names?: Array<string>;
    groups?: Array<string>;

}

export function requestBody(identification: Identification, names?: Array<string>, groups?: Array<string>, device?: string, sessionId?: string): OptimizationChoose {
    return {
        'identification': identification,
        'names': names,
        'groups': groups,
        'device': device,
        'sessionId': sessionId
    }
}