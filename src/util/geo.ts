import { GeoPoint } from '../adapters/types.js';

interface SwissZipEntry {
  zip: string;
  city: string;
  latitude: number;
  longitude: number;
  canton: string;
}

const SWISS_ZIP_DATABASE: SwissZipEntry[] = [
  { zip: '8001', city: 'Zürich', latitude: 47.3769, longitude: 8.5417, canton: 'ZH' },
  { zip: '8002', city: 'Zürich', latitude: 47.3700, longitude: 8.5300, canton: 'ZH' },
  { zip: '8003', city: 'Zürich', latitude: 47.3800, longitude: 8.5200, canton: 'ZH' },
  { zip: '8004', city: 'Zürich', latitude: 47.3750, longitude: 8.5150, canton: 'ZH' },
  { zip: '8005', city: 'Zürich', latitude: 47.3850, longitude: 8.5100, canton: 'ZH' },
  { zip: '8006', city: 'Zürich', latitude: 47.3900, longitude: 8.5300, canton: 'ZH' },
  { zip: '8008', city: 'Zürich', latitude: 47.3650, longitude: 8.5500, canton: 'ZH' },
  { zip: '8009', city: 'Zürich', latitude: 47.3800, longitude: 8.5400, canton: 'ZH' },
  { zip: '8010', city: 'Zürich', latitude: 47.3769, longitude: 8.5417, canton: 'ZH' },
  { zip: '8027', city: 'Zürich', latitude: 47.4000, longitude: 8.5200, canton: 'ZH' },
  { zip: '8031', city: 'Zürich', latitude: 47.3600, longitude: 8.5400, canton: 'ZH' },
  { zip: '8032', city: 'Zürich', latitude: 47.3550, longitude: 8.5350, canton: 'ZH' },
  { zip: '8037', city: 'Zürich', latitude: 47.3500, longitude: 8.5200, canton: 'ZH' },
  { zip: '8041', city: 'Zürich', latitude: 47.3900, longitude: 8.5100, canton: 'ZH' },
  { zip: '8044', city: 'Zürich', latitude: 47.4050, longitude: 8.5300, canton: 'ZH' },
  { zip: '8045', city: 'Zürich', latitude: 47.3800, longitude: 8.4900, canton: 'ZH' },
  { zip: '8046', city: 'Zürich', latitude: 47.3700, longitude: 8.4800, canton: 'ZH' },
  { zip: '8048', city: 'Zürich', latitude: 47.3900, longitude: 8.4700, canton: 'ZH' },
  { zip: '8049', city: 'Zürich', latitude: 47.3850, longitude: 8.4600, canton: 'ZH' },
  { zip: '8050', city: 'Zürich', latitude: 47.3769, longitude: 8.5417, canton: 'ZH' },
  { zip: '8051', city: 'Zürich', latitude: 47.3769, longitude: 8.5417, canton: 'ZH' },
  { zip: '8052', city: 'Zürich', latitude: 47.3769, longitude: 8.5417, canton: 'ZH' },
  { zip: '8053', city: 'Zürich', latitude: 47.3769, longitude: 8.5417, canton: 'ZH' },
  { zip: '8055', city: 'Zürich', latitude: 47.3769, longitude: 8.5417, canton: 'ZH' },
  { zip: '3000', city: 'Bern', latitude: 46.9480, longitude: 7.4474, canton: 'BE' },
  { zip: '3001', city: 'Bern', latitude: 46.9480, longitude: 7.4474, canton: 'BE' },
  { zip: '3003', city: 'Bern', latitude: 46.9500, longitude: 7.4400, canton: 'BE' },
  { zip: '3004', city: 'Bern', latitude: 46.9450, longitude: 7.4500, canton: 'BE' },
  { zip: '3005', city: 'Bern', latitude: 46.9400, longitude: 7.4600, canton: 'BE' },
  { zip: '3006', city: 'Bern', latitude: 46.9550, longitude: 7.4400, canton: 'BE' },
  { zip: '3007', city: 'Bern', latitude: 46.9600, longitude: 7.4300, canton: 'BE' },
  { zip: '3008', city: 'Bern', latitude: 46.9450, longitude: 7.4350, canton: 'BE' },
  { zip: '3010', city: 'Bern', latitude: 46.9480, longitude: 7.4474, canton: 'BE' },
  { zip: '3011', city: 'Bern', latitude: 46.9480, longitude: 7.4474, canton: 'BE' },
  { zip: '3012', city: 'Bern', latitude: 46.9480, longitude: 7.4474, canton: 'BE' },
  { zip: '3013', city: 'Bern', latitude: 46.9480, longitude: 7.4474, canton: 'BE' },
  { zip: '3014', city: 'Bern', latitude: 46.9480, longitude: 7.4474, canton: 'BE' },
  { zip: '3015', city: 'Bern', latitude: 46.9480, longitude: 7.4474, canton: 'BE' },
  { zip: '3018', city: 'Bern', latitude: 46.9480, longitude: 7.4474, canton: 'BE' },
  { zip: '3019', city: 'Bern', latitude: 46.9480, longitude: 7.4474, canton: 'BE' },
  { zip: '3020', city: 'Bern', latitude: 46.9480, longitude: 7.4474, canton: 'BE' },
  { zip: '3027', city: 'Bern', latitude: 46.9500, longitude: 7.4200, canton: 'BE' },
  { zip: '3029', city: 'Bern', latitude: 46.9480, longitude: 7.4474, canton: 'BE' },
  { zip: '1000', city: 'Lausanne', latitude: 46.5197, longitude: 6.6323, canton: 'VD' },
  { zip: '1001', city: 'Lausanne', latitude: 46.5197, longitude: 6.6323, canton: 'VD' },
  { zip: '1003', city: 'Lausanne', latitude: 46.5200, longitude: 6.6300, canton: 'VD' },
  { zip: '1004', city: 'Lausanne', latitude: 46.5150, longitude: 6.6250, canton: 'VD' },
  { zip: '1005', city: 'Lausanne', latitude: 46.5250, longitude: 6.6350, canton: 'VD' },
  { zip: '1006', city: 'Lausanne', latitude: 46.5200, longitude: 6.6400, canton: 'VD' },
  { zip: '1007', city: 'Lausanne', latitude: 46.5100, longitude: 6.6300, canton: 'VD' },
  { zip: '1008', city: 'Lausanne', latitude: 46.5300, longitude: 6.6200, canton: 'VD' },
  { zip: '1010', city: 'Lausanne', latitude: 46.5197, longitude: 6.6323, canton: 'VD' },
  { zip: '1011', city: 'Lausanne', latitude: 46.5197, longitude: 6.6323, canton: 'VD' },
  { zip: '1012', city: 'Lausanne', latitude: 46.5197, longitude: 6.6323, canton: 'VD' },
  { zip: '1014', city: 'Lausanne', latitude: 46.5197, longitude: 6.6323, canton: 'VD' },
  { zip: '1015', city: 'Lausanne', latitude: 46.5197, longitude: 6.6323, canton: 'VD' },
  { zip: '1018', city: 'Lausanne', latitude: 46.5197, longitude: 6.6323, canton: 'VD' },
  { zip: '1020', city: 'Lausanne', latitude: 46.5197, longitude: 6.6323, canton: 'VD' },
  { zip: '1200', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1201', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1202', city: 'Genève', latitude: 46.2000, longitude: 6.1400, canton: 'GE' },
  { zip: '1203', city: 'Genève', latitude: 46.2100, longitude: 6.1500, canton: 'GE' },
  { zip: '1204', city: 'Genève', latitude: 46.2000, longitude: 6.1300, canton: 'GE' },
  { zip: '1205', city: 'Genève', latitude: 46.1950, longitude: 6.1400, canton: 'GE' },
  { zip: '1206', city: 'Genève', latitude: 46.2100, longitude: 6.1300, canton: 'GE' },
  { zip: '1207', city: 'Genève', latitude: 46.2150, longitude: 6.1500, canton: 'GE' },
  { zip: '1208', city: 'Genève', latitude: 46.2200, longitude: 6.1600, canton: 'GE' },
  { zip: '1210', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1211', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1212', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1214', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1215', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1216', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1217', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1218', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1219', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1220', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1224', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1225', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1227', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1228', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1231', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1232', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1233', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1234', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1235', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1236', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1237', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1239', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1240', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1241', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1242', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1243', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1244', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1245', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1246', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1247', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1248', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1251', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1252', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1253', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1254', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1255', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1256', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1257', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '1258', city: 'Genève', latitude: 46.2044, longitude: 6.1432, canton: 'GE' },
  { zip: '4000', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4001', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4002', city: 'Basel', latitude: 47.5600, longitude: 7.5900, canton: 'BS' },
  { zip: '4003', city: 'Basel', latitude: 47.5550, longitude: 7.5850, canton: 'BS' },
  { zip: '4004', city: 'Basel', latitude: 47.5650, longitude: 7.5950, canton: 'BS' },
  { zip: '4005', city: 'Basel', latitude: 47.5500, longitude: 7.5800, canton: 'BS' },
  { zip: '4006', city: 'Basel', latitude: 47.5700, longitude: 7.5900, canton: 'BS' },
  { zip: '4007', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4008', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4009', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4010', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4011', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4012', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4013', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4014', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4015', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4016', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4017', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4018', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4019', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4020', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4021', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4022', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4023', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4024', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4025', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4026', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4027', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4028', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4029', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '4030', city: 'Basel', latitude: 47.5596, longitude: 7.5886, canton: 'BS' },
  { zip: '6000', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6001', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6002', city: 'Luzern', latitude: 47.0500, longitude: 8.3100, canton: 'LU' },
  { zip: '6003', city: 'Luzern', latitude: 47.0450, longitude: 8.3050, canton: 'LU' },
  { zip: '6004', city: 'Luzern', latitude: 47.0550, longitude: 8.3150, canton: 'LU' },
  { zip: '6005', city: 'Luzern', latitude: 47.0400, longitude: 8.3000, canton: 'LU' },
  { zip: '6006', city: 'Luzern', latitude: 47.0600, longitude: 8.3200, canton: 'LU' },
  { zip: '6007', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6008', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6009', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6010', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6011', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6012', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6013', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6014', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6015', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6016', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6017', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6018', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6019', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '6020', city: 'Luzern', latitude: 47.0502, longitude: 8.3093, canton: 'LU' },
  { zip: '9000', city: 'St. Gallen', latitude: 47.4245, longitude: 9.3767, canton: 'SG' },
  { zip: '9001', city: 'St. Gallen', latitude: 47.4245, longitude: 9.3767, canton: 'SG' },
  { zip: '9002', city: 'St. Gallen', latitude: 47.4200, longitude: 9.3700, canton: 'SG' },
  { zip: '9003', city: 'St. Gallen', latitude: 47.4300, longitude: 9.3800, canton: 'SG' },
  { zip: '9004', city: 'St. Gallen', latitude: 47.4150, longitude: 9.3650, canton: 'SG' },
  { zip: '9005', city: 'St. Gallen', latitude: 47.4350, longitude: 9.3900, canton: 'SG' },
  { zip: '9006', city: 'St. Gallen', latitude: 47.4245, longitude: 9.3767, canton: 'SG' },
  { zip: '9007', city: 'St. Gallen', latitude: 47.4245, longitude: 9.3767, canton: 'SG' },
  { zip: '9008', city: 'St. Gallen', latitude: 47.4245, longitude: 9.3767, canton: 'SG' },
  { zip: '9009', city: 'St. Gallen', latitude: 47.4245, longitude: 9.3767, canton: 'SG' },
  { zip: '9010', city: 'St. Gallen', latitude: 47.4245, longitude: 9.3767, canton: 'SG' },
  { zip: '9011', city: 'St. Gallen', latitude: 47.4245, longitude: 9.3767, canton: 'SG' },
  { zip: '9012', city: 'St. Gallen', latitude: 47.4245, longitude: 9.3767, canton: 'SG' },
  { zip: '9013', city: 'St. Gallen', latitude: 47.4245, longitude: 9.3767, canton: 'SG' },
  { zip: '9014', city: 'St. Gallen', latitude: 47.4245, longitude: 9.3767, canton: 'SG' },
  { zip: '9015', city: 'St. Gallen', latitude: 47.4245, longitude: 9.3767, canton: 'SG' },
  { zip: '9016', city: 'St. Gallen', latitude: 47.4245, longitude: 9.3767, canton: 'SG' },
  { zip: '9500', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9501', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9502', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9503', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9504', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9505', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9506', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9507', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9508', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9509', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9510', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9511', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9512', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9513', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9514', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9515', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9516', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '1950', city: 'Sion', latitude: 46.2333, longitude: 7.3500, canton: 'VS' },
  { zip: '3800', city: 'Interlaken', latitude: 46.6863, longitude: 7.8632, canton: 'BE' },
  { zip: '5000', city: 'Aarau', latitude: 47.3923, longitude: 8.0453, canton: 'AG' },
  { zip: '6300', city: 'Zug', latitude: 47.1723, longitude: 8.5170, canton: 'ZG' },
  { zip: '6500', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '7000', city: 'Chur', latitude: 46.8509, longitude: 9.5318, canton: 'GR' },
  { zip: '7300', city: 'Bad Ragaz', latitude: 47.0100, longitude: 9.4800, canton: 'SG' },
  { zip: '8180', city: 'Bülach', latitude: 47.5218, longitude: 8.5416, canton: 'ZH' },
  { zip: '8200', city: 'Schaffhausen', latitude: 47.6973, longitude: 8.6356, canton: 'SH' },
  { zip: '8300', city: 'Winterthur', latitude: 47.4984, longitude: 8.7291, canton: 'ZH' },
  { zip: '8400', city: 'Baden', latitude: 47.4733, longitude: 8.3063, canton: 'AG' },
  { zip: '8500', city: 'Frauenfeld', latitude: 47.5538, longitude: 8.8989, canton: 'TG' },
  { zip: '8600', city: 'Dübendorf', latitude: 47.3972, longitude: 8.6183, canton: 'ZH' },
  { zip: '8700', city: 'Kloten', latitude: 47.4520, longitude: 8.5845, canton: 'ZH' },
  { zip: '8800', city: 'Thalwil', latitude: 47.2917, longitude: 8.5600, canton: 'ZH' },
  { zip: '8900', city: 'Arbon', latitude: 47.5167, longitude: 9.4333, canton: 'TG' },
  { zip: '8640', city: 'Rapperswil-Jona', latitude: 47.2275, longitude: 8.8225, canton: 'SG' },
  { zip: '9500', city: 'Bellinzona', latitude: 46.1963, longitude: 9.0245, canton: 'TI' },
  { zip: '9600', city: 'Romanshorn', latitude: 47.5667, longitude: 9.3833, canton: 'TG' },
  { zip: '1110', city: 'Morges', latitude: 46.5118, longitude: 6.4988, canton: 'VD' },
  { zip: '1310', city: 'Daillens', latitude: 46.5667, longitude: 6.4500, canton: 'VD' },
  { zip: '1400', city: 'Yverdon-les-Bains', latitude: 46.7781, longitude: 6.6411, canton: 'VD' },
  { zip: '1500', city: 'Moudon', latitude: 46.7167, longitude: 6.8000, canton: 'VD' },
  { zip: '1630', city: 'Bulle', latitude: 46.6211, longitude: 7.0522, canton: 'FR' },
  { zip: '1700', city: 'Fribourg', latitude: 46.8027, longitude: 7.1512, canton: 'FR' },
  { zip: '1800', city: 'Vevey', latitude: 46.4630, longitude: 6.8418, canton: 'VD' },
  { zip: '2000', city: 'Neuchâtel', latitude: 46.9917, longitude: 6.9292, canton: 'NE' },
  { zip: '2500', city: 'Biel/Bienne', latitude: 47.1368, longitude: 7.2467, canton: 'BE' },
  { zip: '3600', city: 'Thun', latitude: 46.7581, longitude: 7.6281, canton: 'BE' },
  { zip: '4500', city: 'Solothurn', latitude: 47.2083, longitude: 7.5325, canton: 'SO' },
  { zip: '6900', city: 'Lugano', latitude: 46.0037, longitude: 8.9511, canton: 'TI' },
  { zip: '6600', city: 'Locarno', latitude: 46.1710, longitude: 8.8000, canton: 'TI' },
  { zip: '7270', city: 'Davos', latitude: 46.8027, longitude: 9.8362, canton: 'GR' },
  { zip: '7500', city: 'St. Moritz', latitude: 46.4975, longitude: 9.8385, canton: 'GR' },
  { zip: '3900', city: 'Brig', latitude: 46.3167, longitude: 7.9869, canton: 'VS' },
  { zip: '3950', city: 'Sierre', latitude: 46.2917, longitude: 7.5333, canton: 'VS' },
  { zip: '1920', city: 'Martigny', latitude: 46.1028, longitude: 7.0725, canton: 'VS' },
  { zip: '1820', city: 'Montreux', latitude: 46.4312, longitude: 6.9107, canton: 'VD' },
  { zip: '1260', city: 'Nyon', latitude: 46.3833, longitude: 6.2333, canton: 'VD' },
  { zip: '1410', city: 'Aigle', latitude: 46.3167, longitude: 7.0000, canton: 'VD' },
  { zip: '2800', city: 'Delémont', latitude: 47.3667, longitude: 7.3500, canton: 'JU' },
  { zip: '2900', city: 'Porrentruy', latitude: 47.4167, longitude: 7.0833, canton: 'JU' },
  { zip: '8750', city: 'Glarus', latitude: 47.0333, longitude: 9.0667, canton: 'GL' },
  { zip: '6430', city: 'Schwyz', latitude: 47.0208, longitude: 8.6528, canton: 'SZ' },
  { zip: '6460', city: 'Altdorf', latitude: 46.8800, longitude: 8.6433, canton: 'UR' },
  { zip: '6060', city: 'Sarnen', latitude: 46.8961, longitude: 8.2456, canton: 'OW' },
  { zip: '6380', city: 'Engelberg', latitude: 46.8189, longitude: 8.4108, canton: 'OW' },
  { zip: '6210', city: 'Sursee', latitude: 47.1714, longitude: 8.1600, canton: 'LU' },
  { zip: '6130', city: 'Willisau', latitude: 47.1167, longitude: 8.0167, canton: 'LU' },
  { zip: '4950', city: 'Huttwil', latitude: 47.1167, longitude: 7.8667, canton: 'BE' },
  { zip: '4900', city: 'Langenthal', latitude: 47.2167, longitude: 7.7833, canton: 'BE' },
  { zip: '3400', city: 'Burgdorf', latitude: 47.0589, longitude: 7.6264, canton: 'BE' },
  { zip: '2300', city: 'La Chaux-de-Fonds', latitude: 47.0972, longitude: 6.8292, canton: 'NE' },
  { zip: '2400', city: 'Le Locle', latitude: 47.0833, longitude: 6.7333, canton: 'NE' },
  { zip: '9400', city: 'Rorschach', latitude: 47.4833, longitude: 9.4833, canton: 'SG' },
  { zip: '8730', city: 'Uznach', latitude: 47.2333, longitude: 8.9833, canton: 'SG' },
  { zip: '8808', city: 'Pfäffikon', latitude: 47.1833, longitude: 8.7667, canton: 'SZ' },
  { zip: '8840', city: 'Einsiedeln', latitude: 47.1283, longitude: 8.7464, canton: 'SZ' },
  { zip: '8953', city: 'Dietikon', latitude: 47.4017, longitude: 8.4000, canton: 'ZH' },
  { zip: '8610', city: 'Uster', latitude: 47.3500, longitude: 8.6500, canton: 'ZH' },
  { zip: '8820', city: 'Wädenswil', latitude: 47.2650, longitude: 8.6710, canton: 'ZH' },
  { zip: '8805', city: 'Richterswil', latitude: 47.2083, longitude: 8.7000, canton: 'ZH' },
  { zip: '5620', city: 'Bremgarten', latitude: 47.3500, longitude: 8.3500, canton: 'AG' },
  { zip: '5507', city: 'Spreitenbach', latitude: 47.4167, longitude: 8.3667, canton: 'AG' },
  { zip: '5430', city: 'Wettingen', latitude: 47.4667, longitude: 8.3167, canton: 'AG' },
  { zip: '4270', city: 'Laufen', latitude: 47.4167, longitude: 7.5000, canton: 'BL' },
  { zip: '4410', city: 'Liestal', latitude: 47.4833, longitude: 7.7333, canton: 'BL' },
  { zip: '4450', city: 'Sissach', latitude: 47.4667, longitude: 7.8167, canton: 'BL' },
];

const zipIndex = new Map<string, SwissZipEntry>();
for (const entry of SWISS_ZIP_DATABASE) {
  zipIndex.set(entry.zip, entry);
}

const cityIndex = new Map<string, SwissZipEntry[]>();
for (const entry of SWISS_ZIP_DATABASE) {
  const normalizedCity = entry.city.toLowerCase();
  const existing = cityIndex.get(normalizedCity);
  if (existing) {
    existing.push(entry);
  } else {
    cityIndex.set(normalizedCity, [entry]);
  }
}

function haversineDistance(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const sinHalfDlat = Math.sin(dLat / 2);
  const sinHalfDlon = Math.sin(dLon / 2);
  const h =
    sinHalfDlat * sinHalfDlat + Math.cos(lat1) * Math.cos(lat2) * sinHalfDlon * sinHalfDlon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function resolveLocation(location: string): GeoPoint | undefined {
  const trimmed = location.trim();
  const zipMatch = trimmed.match(/^(\d{4})\s+(.+)$/);
  if (zipMatch) {
    const zipEntry = zipIndex.get(zipMatch[1]);
    if (zipEntry) {
      return { latitude: zipEntry.latitude, longitude: zipEntry.longitude };
    }
  }

  const pureZipMatch = trimmed.match(/^(\d{4})$/);
  if (pureZipMatch) {
    const zipEntry = zipIndex.get(pureZipMatch[1]);
    if (zipEntry) {
      return { latitude: zipEntry.latitude, longitude: zipEntry.longitude };
    }
  }

  const normalizedCity = trimmed.toLowerCase();
  const cityEntries = cityIndex.get(normalizedCity);
  if (cityEntries && cityEntries.length > 0) {
    return { latitude: cityEntries[0].latitude, longitude: cityEntries[0].longitude };
  }

  return undefined;
}

export function findNearbyLocations(
  center: GeoPoint,
  radiusKm: number
): Array<{ entry: SwissZipEntry; distance: number }> {
  return SWISS_ZIP_DATABASE.map((entry) => ({
    entry,
    distance: haversineDistance(center, { latitude: entry.latitude, longitude: entry.longitude }),
  }))
    .filter((item) => item.distance <= radiusKm)
    .sort((a, b) => a.distance - b.distance);
}

export function distanceBetween(a: GeoPoint, b: GeoPoint): number {
  return haversineDistance(a, b);
}
