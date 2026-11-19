import { storeAndSendOtp, verifyOtp } from '../src/lib/emailOtp';

async function runTests() {
  console.log('--- Starting OTP Verification Tests ---');

  // Test 1: Standard Register flow
  const email1 = 'souma.test1@gmail.com';
  const gen1 = await storeAndSendOtp(email1, 'REGISTER');
  console.log('Test 1 Generated OTP:', gen1.devOtpPreview);
  if (!gen1.devOtpPreview) throw new Error('Failed to generate OTP preview in dev mode');

  const ver1 = await verifyOtp(email1, gen1.devOtpPreview);
  console.log('Test 1 Verification:', ver1);
  if (!ver1.valid) throw new Error('Test 1 failed: ' + ver1.reason);

  // Test 2: Replay prevention (should fail because code was deleted on successful use)
  const ver1Replay = await verifyOtp(email1, gen1.devOtpPreview);
  console.log('Test 2 Replay Prevention:', ver1Replay);
  if (ver1Replay.valid) throw new Error('Test 2 failed: OTP was allowed to be reused!');

  // Test 3: Tab-switch resilience (Generated under LOGIN_OTP, verified in REGISTER flow)
  const email2 = 'souma.test2@gmail.com';
  const gen2 = await storeAndSendOtp(email2, 'LOGIN_OTP');
  console.log('Test 3 Generated OTP (LOGIN_OTP):', gen2.devOtpPreview);
  const ver2 = await verifyOtp(email2, gen2.devOtpPreview!);
  console.log('Test 3 Cross-purpose Verification:', ver2);
  if (!ver2.valid) throw new Error('Test 3 failed: ' + ver2.reason);

  // Test 4: Whitespace and casing tolerance
  const email3 = '  Souma.Test3@Example.COM  ';
  const gen3 = await storeAndSendOtp(email3, 'REGISTER');
  const ver3 = await verifyOtp('souma.test3@example.com', gen3.devOtpPreview!);
  console.log('Test 4 Casing/Whitespace Verification:', ver3);
  if (!ver3.valid) throw new Error('Test 4 failed: ' + ver3.reason);

  // Test 5: Wrong OTP code
  const email4 = 'souma.test4@gmail.com';
  await storeAndSendOtp(email4, 'REGISTER');
  const ver4 = await verifyOtp(email4, '000000');
  console.log('Test 5 Incorrect Code Verification:', ver4);
  if (ver4.valid || !ver4.reason?.includes('Incorrect')) {
    throw new Error('Test 5 failed: Wrong OTP was not rejected properly');
  }

  console.log('\n>>> ALL 5 OTP TESTS PASSED PERFECTLY! <<<');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
