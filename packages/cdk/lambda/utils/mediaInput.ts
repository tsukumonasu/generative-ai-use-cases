// What the direct-invoke media Lambdas (invokeGptImage.ts,
// invokeGemini.ts) share on the input side — who is calling, and turning
// inputs that reference media already in the file bucket into bytes.

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const s3Client = new S3Client({});

const createVerifier = () =>
  CognitoJwtVerifier.create({
    userPoolId: process.env.USER_POOL_ID!,
    tokenUse: 'id',
    clientId: process.env.USER_POOL_CLIENT_ID!,
  });

// Created on first use and kept across warm invocations (the JWKS cache
// lives in it)
let verifier: ReturnType<typeof createVerifier> | undefined;

// The functions are invoked with IAM auth (Identity Pool authenticated
// role), which carries no Cognito claims — the user identity for chat
// recording comes from the ID token in the payload.
export const verifyMediaUser = async (
  idToken: string | undefined
): Promise<string> => {
  verifier ??= createVerifier();
  const payload = await verifier.verify(idToken ?? '');
  return payload['cognito:username'] as string;
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

// Object key of an S3 URL of the form
// https://<bucket>.s3.<region>.amazonaws.com/<key> (the format the media
// Lambdas store, see mediaHistory.ts), or undefined when the URL is anything
// else — another bucket, another host, not https. The bucket name is matched
// literally. The key is everything after the host, URL-decoded; a malformed
// percent-encoding throws URIError.
export const parseOwnBucketS3Key = (
  s3Url: string,
  bucket: string
): string | undefined => {
  const keyPattern = new RegExp(
    `^https://${escapeRegExp(bucket)}\\.s3\\.[a-z0-9-]+\\.amazonaws\\.com/(?<key>.+)$`
  );
  const key = keyPattern.exec(s3Url)?.groups?.key;
  return key ? decodeURIComponent(key) : undefined;
};

// Inputs referencing previously generated media arrive as S3 URLs
// (to keep the invoke payload small) — download and convert to base64.
// Only URLs pointing at our own file bucket are allowed.
// `label` is the word used in the error messages ('image' / 'media').
export const resolveS3Inputs = async <
  T extends { data?: string; s3Url?: string },
>(
  items: T[],
  label: string
): Promise<T[]> => {
  const bucket = process.env.BUCKET_NAME!;

  return Promise.all(
    items.map(async (item) => {
      if (!item.s3Url) {
        if (!item.data) {
          throw new Error(`Each input ${label} must have either data or s3Url`);
        }
        return item;
      }

      const key = parseOwnBucketS3Key(item.s3Url, bucket);
      if (!key) {
        throw new Error(`Invalid input ${label} S3 URL`);
      }

      const res = await s3Client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );
      const bytes = await res.Body!.transformToByteArray();
      return { ...item, data: Buffer.from(bytes).toString('base64') };
    })
  );
};
