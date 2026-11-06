/**
 * GSTIN: 15 characters = 2-digit state code + 10-character PAN + entity number + "Z" + check char.
 * The check character uses the GSTN base-36 checksum (Luhn mod 36 variant).
 */

const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Indian GST state/UT codes (as used in GSTIN prefixes). */
export const GST_STATES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
};

export function isGstStateCode(code: string): boolean {
  return code in GST_STATES;
}

/** The check character for the first 14 characters of a GSTIN. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHARSET.indexOf(first14[i] ?? "");
    if (value < 0) {
      throw new Error("Invalid GSTIN character");
    }
    const factor = i % 2 === 0 ? 1 : 2;
    const product = value * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36] as string;
}

export type GstinCheck =
  | { valid: true; stateCode: string; pan: string }
  | { valid: false; reason: "format" | "state" | "checksum" };

export function checkGstin(input: string): GstinCheck {
  const gstin = input.trim().toUpperCase();
  if (!GSTIN_RE.test(gstin)) {
    return { valid: false, reason: "format" };
  }
  const stateCode = gstin.slice(0, 2);
  if (!isGstStateCode(stateCode)) {
    return { valid: false, reason: "state" };
  }
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) {
    return { valid: false, reason: "checksum" };
  }
  return { valid: true, stateCode, pan: gstin.slice(2, 12) };
}

export const GSTIN_MESSAGES: Record<"format" | "state" | "checksum", string> = {
  format: "A GSTIN has 15 characters, e.g. 27AAPFU0939F1ZV.",
  state: "The first two digits are not a valid state code.",
  checksum: "This GSTIN fails its check digit. Please re-check it.",
};
