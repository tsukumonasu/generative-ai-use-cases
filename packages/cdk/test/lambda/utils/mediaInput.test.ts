import { parseOwnBucketS3Key } from '../../../lambda/utils/mediaInput';

const BUCKET = 'genu-file-bucket-123';
const HOST = `https://${BUCKET}.s3.ap-northeast-1.amazonaws.com`;

describe('parseOwnBucketS3Key', () => {
  test('takes the key of a URL in the own bucket, in any region', () => {
    expect(parseOwnBucketS3Key(`${HOST}/uuid/generated-1.png`, BUCKET)).toBe(
      'uuid/generated-1.png'
    );
    expect(
      parseOwnBucketS3Key(
        `https://${BUCKET}.s3.us-east-1.amazonaws.com/a/b/c.mp4`,
        BUCKET
      )
    ).toBe('a/b/c.mp4');
  });

  test('decodes the key, and keeps everything after the host in it', () => {
    expect(parseOwnBucketS3Key(`${HOST}/uuid/my%20file%2B1.png`, BUCKET)).toBe(
      'uuid/my file+1.png'
    );
    // Not parsed as a URL: a query string stays part of the key
    expect(parseOwnBucketS3Key(`${HOST}/uuid/a.png?x=1`, BUCKET)).toBe(
      'uuid/a.png?x=1'
    );
    expect(() => parseOwnBucketS3Key(`${HOST}/uuid/%E0%.png`, BUCKET)).toThrow(
      URIError
    );
  });

  test('rejects other buckets, hosts and schemes', () => {
    for (const url of [
      '',
      'uuid/generated-1.png',
      // No key
      HOST,
      `${HOST}/`,
      // Another bucket
      'https://other-bucket.s3.ap-northeast-1.amazonaws.com/k.png',
      // The bucket name as a prefix / suffix of another bucket or host
      `https://evil-${BUCKET}.s3.ap-northeast-1.amazonaws.com/k.png`,
      `https://${BUCKET}-evil.s3.ap-northeast-1.amazonaws.com/k.png`,
      `https://evil.${BUCKET}.s3.ap-northeast-1.amazonaws.com/k.png`,
      `https://${BUCKET}.evil.com/k.png`,
      `https://${BUCKET}.s3.ap-northeast-1.amazonaws.com.evil.com/k.png`,
      `https://${BUCKET}.s3.ap-northeast-1.amazonaws.com@evil.com/k.png`,
      `https://${BUCKET}.s3.evil.com/amazonaws.com/k.png`,
      `https://evil.com/${HOST}/k.png`,
      `https://evil.com/?u=${HOST}/k.png`,
      // Not https
      `http://${BUCKET}.s3.ap-northeast-1.amazonaws.com/k.png`,
      `s3://${BUCKET}/k.png`,
      // Not this URL format (no region, path style, port, other services)
      `https://${BUCKET}.s3.amazonaws.com/k.png`,
      `https://s3.ap-northeast-1.amazonaws.com/${BUCKET}/k.png`,
      `https://${BUCKET}.s3.AP-NORTHEAST-1.amazonaws.com/k.png`,
      `https://${BUCKET}.s3.ap-northeast-1.amazonaws.com:8443/k.png`,
      `https://${BUCKET}.lambda.ap-northeast-1.amazonaws.com/k.png`,
      // Anything before or after the URL
      ` ${HOST}/k.png`,
      `${HOST}/k.png\nhttps://evil.com/`,
    ]) {
      expect(parseOwnBucketS3Key(url, BUCKET)).toBeUndefined();
    }
  });

  test('matches the bucket name literally, not as a pattern', () => {
    // "." in a bucket name is a dot, not "any character"
    const dotted = 'my.file.bucket';
    expect(
      parseOwnBucketS3Key(
        `https://${dotted}.s3.us-east-1.amazonaws.com/k.png`,
        dotted
      )
    ).toBe('k.png');
    for (const url of [
      'https://myxfilexbucket.s3.us-east-1.amazonaws.com/k.png',
      'https://my-file-bucket.s3.us-east-1.amazonaws.com/k.png',
      'https://my/file/bucket.s3.us-east-1.amazonaws.com/k.png',
    ]) {
      expect(parseOwnBucketS3Key(url, dotted)).toBeUndefined();
    }

    // Pattern characters in the configured name do not widen the match
    const cases: [string, string][] = [
      ['.*', 'https://evil.com/x.s3.us-east-1.amazonaws.com/k.png'],
      ['a|b', 'https://a'],
      ['a|b', 'https://b.s3.us-east-1.amazonaws.com/k.png'],
      ['(a)+', 'https://aaa.s3.us-east-1.amazonaws.com/k.png'],
      ['[a-z]+', 'https://other.s3.us-east-1.amazonaws.com/k.png'],
      ['a?', 'https://.s3.us-east-1.amazonaws.com/k.png'],
    ];
    for (const [bucket, url] of cases) {
      expect(parseOwnBucketS3Key(url, bucket)).toBeUndefined();
    }
  });
});
