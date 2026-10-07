export type SignupInput = {
  company_name: string;
  name?: string;
  login: string;
  password: string;
  lang?: string;
};

export type SignupResult = {
  ok: boolean;
  login: string;
  company_id: number;
  company_name: string;
};

export async function signup(input: SignupInput): Promise<SignupResult> {
  const res = await fetch('/bn/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });

  let json: Partial<SignupResult> & { error?: string } = {};
  try {
    json = JSON.parse(await res.text());
  } catch {
    throw new Error('সার্ভার থেকে সঠিক উত্তর আসেনি');
  }
  if (!res.ok || !json.ok) throw new Error(json.error || 'অ্যাকাউন্ট তৈরি হয়নি');
  return json as SignupResult;
}