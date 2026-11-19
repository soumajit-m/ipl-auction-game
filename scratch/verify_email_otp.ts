import { storeAndSendOtp, verifyOtp, generate6DigitOtp } from '../src/lib/emailOtp';
import { signHostToken, verifyHostToken } from '../src/lib/auth';

async function testEmailOtpAuth() {
  console.log('=== STARTING EMAIL + OTP HOST AUTHENTICATION TESTS ===\n');

  // Test 1: Generate 6-Digit Cryptographic Numeric Code
  console.log('--- TEST 1: 6-Digit Code Generation ---');
  const code = generate6DigitOtp();
  console.log('Generated Code:', code);
  if (!/^\d{6}$/.test(code)) {
    throw new Error(`Code ${code} is not a 6-digit numeric string`);
  }
  console.log('✓ 6-Digit code strictly matches regex ^\\d{6}$');

  // Test 2: Send OTP
  console.log('\n--- TEST 2: Send OTP (Dev Mode Fallback) ---');
  const testEmail = 'host_tester_' + Date.now() + '@iplmanager.com';
  const sendRes = await storeAndSendOtp(testEmail, 'REGISTER');
  console.log('Send OTP Result:', sendRes);
  if (!sendRes.success) {
    throw new Error('storeAndSendOtp failed');
  }
  if (!sendRes.devOtpPreview) {
    throw new Error('Expected devOtpPreview in dev mode');
  }
  console.log(`✓ storeAndSendOtp succeeded with preview code: ${sendRes.devOtpPreview}`);

  // Test 3: Reject incorrect OTP
  console.log('\n--- TEST 3: Reject Incorrect OTP ---');
  const wrongCode = sendRes.devOtpPreview === '123456' ? '654321' : '123456';
  const rejectRes = await verifyOtp(testEmail, wrongCode, 'REGISTER');
  console.log('Wrong OTP Verification:', rejectRes);
  if (rejectRes.valid) {
    throw new Error('Wrong OTP was mistakenly accepted!');
  }
  console.log('✓ Wrong OTP correctly rejected with reason:', rejectRes.reason);

  // Test 4: Accept correct OTP
  console.log('\n--- TEST 4: Accept Correct OTP ---');
  const acceptRes = await verifyOtp(testEmail, sendRes.devOtpPreview, 'REGISTER');
  console.log('Correct OTP Verification:', acceptRes);
  if (!acceptRes.valid) {
    throw new Error('Correct OTP failed verification: ' + acceptRes.reason);
  }
  console.log('✓ Correct OTP successfully verified');

  // Test 5: Re-use prevention (OTP single-use)
  console.log('\n--- TEST 5: Verify Re-Use Prevention (Single-Use OTP) ---');
  const reuseRes = await verifyOtp(testEmail, sendRes.devOtpPreview, 'REGISTER');
  console.log('Re-use OTP Verification:', reuseRes);
  if (reuseRes.valid) {
    throw new Error('OTP was able to be re-used! Should be single-use.');
  }
  console.log('✓ Single-use verified (OTP deleted after first successful verification)');

  // Test 6: Host JWT with Email and Name
  console.log('\n--- TEST 6: Host JWT with Email & Name ---');
  const hostId = 'host_user_777';
  const name = 'Souma Host Admin';
  const token = signHostToken(hostId, testEmail, name);
  const payload = verifyHostToken(token);
  console.log('Verified JWT Payload:', payload);
  if (payload?.hostId !== hostId || payload?.email !== testEmail || payload?.name !== name) {
    throw new Error('JWT payload missing email, name or hostId');
  }
  console.log('✓ JWT payload verified with hostId, email, and name');

  console.log('\n=== ALL EMAIL + OTP AUTH TESTS PASSED SUCCESSFULLY ===');
  process.exit(0);
}

testEmailOtpAuth().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
