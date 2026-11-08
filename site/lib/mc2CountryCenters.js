// Approximate geographic centroids for ISO codes; the code list follows the public-domain tzdata ISO table.
// ISO 3166-1 alpha-2 codes map to [latitude, longitude] in degrees.
// XK adds the commonly used Kosovo code to the assigned ISO codes.
const centers = `
AF 33 66
AL 41 20
DZ 28 3
AO -12 18
AR -34 -64
AM 40 45
AU -25 134
AT 47.6 14.1
AZ 40 47
BD 24 90
BY 53 28
BE 50.5 4.7
BJ 10 2
BO -17 -65
BA 44 18
BW -22 24
BR -10 -53
BG 42.7 25.5
BF 12 -2
BI -3 30
KH 13 105
CM 6 12
CA 57 -106
CF 7 21
TD 15 19
CL -30 -71
CN 35 103
CO 4 -73
CD -3 23
CG -1 15
CR 10 -84
CI 7.5 -5.5
HR 45.1 15.3
CU 21 -79
CY 35 33
CZ 49.8 15.5
DK 56 10
DJ 11.5 43
DO 19 -70
EC -2 -77
EG 26 30
SV 13.7 -89
ER 15 39
EE 58.7 25.5
ET 9 40
FI 64 26
FR 46.5 2.5
GA -1 11.6
GM 13.4 -16.6
GE 42 43
DE 51.2 10.4
GH 8 -2
GR 39 22
GT 15 -90
GN 11 -10
HT 19 -72
HN 15 -86
HK 22.3 114.2
HU 47 19
IN 22 79
ID -2 118
IR 32 53
IQ 33 44
IE 53 -8
IL 31 35
IT 42.8 12.8
JP 36 138
JO 31 36
KZ 48 68
KE 1 38
KP 40 127
KR 36 128
KW 29 47
KG 41 75
LA 19 103
LV 57 25
LB 33 35
LS -29 28
LR 6.4 -9.4
LY 27 17
LT 55 24
LU 49.8 6.1
MG -20 47
MW -13 34
MY 4 102
ML 17 -4
MR 20 -10
MX 23 -102
MD 47 29
MN 46 105
ME 42.5 19.3
MA 32 -6
MZ -18 35
MM 21 96
NA -22 17
NP 28 84
NL 52.2 5.3
NZ -41 174
NI 13 -85
NE 17 9
NG 10 8
MK 41.6 21.7
NO 61 8
OM 21 57
PK 30 70
PA 9 -80
PG -6 147
PY -23 -58
PE -10 -76
PH 13 122
PL 52 19
PT 39.5 -8
PR 18 -66
QA 25 51
RO 45.9 25
RU 60 100
RW -2 30
SA 24 45
SN 14 -14
RS 44 21
SL 8.5 -11.8
SG 1.35 103.8
SK 48.7 19.7
SI 46.1 14.9
SO 6 46
ZA -29 24
SS 7 30
ES 40 -4
LK 7 81
SD 15 30
SE 62 15
CH 47 8
SY 35 38
TW 23.7 121
TJ 39 71
TZ -6 35
TH 15 101
TG 8 1
TN 34 9
TR 39 35
TM 40 59
UG 1 32
UA 49 32
AE 24 54
GB 54 -2
US 39 -98
UY -33 -56
UZ 41 64
VE 8 -66
VN 16 108
YE 15 48
ZM -14 28
ZW -19 29
IS 65 -18
MT 35.9 14.4
XK 42.6 21
AD 42.55 1.58
AG 17.06 -61.8
AI 18.22 -63.05
AQ -82 0
AS -14.3 -170.7
AW 12.5 -69.97
AX 60.2 20
BB 13.19 -59.54
BH 26 50.5
BL 17.9 -62.83
BM 32.3 -64.8
BN 4.5 114.7
BQ 12.2 -68.3
BS 24.25 -76
BT 27.4 90.4
BV -54.4 3.4
BZ 17.2 -88.7
CC -12.2 96.8
CK -21.2 -159.8
CV 16 -24
CW 12.2 -69
CX -10.5 105.6
DM 15.4 -61.4
EH 24.2 -12.9
FJ -17.7 178.1
FK -51.8 -59.5
FM 6.9 158.2
FO 61.9 -6.9
GD 12.1 -61.7
GF 4 -53
GG 49.45 -2.58
GI 36.14 -5.35
GL 72 -40
GP 16.2 -61.5
GQ 1.6 10.4
GS -54.4 -36.6
GU 13.4 144.8
GW 12 -15
GY 5 -59
HM -53.1 73.5
IM 54.2 -4.5
IO -6 72
JE 49.2 -2.1
JM 18.1 -77.3
KI 1.9 -157.4
KM -11.7 43.3
KN 17.3 -62.7
KY 19.3 -81.2
LC 13.9 -60.9
LI 47.16 9.55
MC 43.74 7.42
MF 18.1 -63.05
MH 9 168
MO 22.2 113.5
MP 15.2 145.7
MQ 14.7 -61
MS 16.75 -62.2
MU -20.2 57.5
MV 3.2 73.2
NC -21.3 165.5
NF -29 168
NR -0.5 166.9
NU -19.05 -169.9
PF -17.7 -149.4
PM 46.8 -56.3
PN -25.1 -130.1
PS 31.9 35.2
PW 7.5 134.5
RE -21.1 55.5
SB -9.6 160
SC -4.7 55.5
SH -15.9 -5.7
SJ 78 20
SM 43.9 12.45
SR 4 -56
ST 0.2 6.6
SX 18.04 -63.05
SZ -26.5 31.5
TC 21.7 -71.8
TF -49.3 69.3
TK -9.2 -171.8
TL -8.8 125.8
TO -21.2 -175.2
TT 10.7 -61.2
TV -8.5 179.2
UM 16 -171
VA 41.9 12.45
VC 13.25 -61.2
VG 18.4 -64.6
VI 18.3 -64.9
VU -16 167
WF -13.3 -176.2
WS -13.8 -172.1
YT -12.8 45.1
`;

const CENTERS = new Map(centers.trim().split('\n').map((line) => {
  const [code, lat, lon] = line.trim().split(/\s+/);
  return [code, [Number(lat), Number(lon)]];
}));

export const COUNTRY_CENTER_COUNT = CENTERS.size;

export function countryCenter(code) {
  return CENTERS.get(String(code ?? '').toUpperCase()) ?? null;
}

export function placeCountries(countries) {
  const placed = [];
  let unplaced = 0;
  for (const country of countries) {
    const center = countryCenter(country.code);
    if (!center) { unplaced += 1; continue; }
    placed.push({ ...country, center });
  }
  return { placed, unplaced };
}
