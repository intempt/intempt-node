export interface Identification {
    userId?: string;
    profileId?: string;
    sourceId?: number;
}

export function identifyByProfile(profileId: string, sourceId: number): Identification {
    return {
        'profileId': profileId,
        'sourceId': sourceId
    }
}

export function identifyByUser(userId: string): Identification {
    return {
        'userId': userId
    }
}