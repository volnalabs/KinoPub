#!/usr/bin/env python3
"""
Подпись Tizen-виджета (W3C XML Digital Signatures for Widgets, профиль Tizen):
создаёт author-signature.xml и signature1.xml в каталоге с содержимым WGT.

  python3 tools/sign_wgt.py <каталог> --author author.p12 --author-pass PASS \
                                     --distributor distributor.p12 --distributor-pass PASS

Для Samsung TV нужны сертификаты Samsung (Tizen Studio → Certificate Manager →
Samsung, профиль TV), файлы обычно лежат в ~/SamsungCertificate/<профиль>/.
Зависимости: python3-cryptography, python3-lxml.
"""
import argparse
import base64
import hashlib
import os
import sys
from urllib.parse import quote

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa, utils
    from cryptography.hazmat.primitives.serialization import pkcs12
    from lxml import etree
except ImportError as e:  # pragma: no cover
    sys.exit('Нужны пакеты cryptography и lxml: pip3 install cryptography lxml (%s)' % e)

DSIG = 'http://www.w3.org/2000/09/xmldsig#'
DSP = 'http://www.w3.org/2009/xmldsig-properties'
EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#'
C14N11 = 'http://www.w3.org/2006/12/xml-c14n11'
SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256'
RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
ECDSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256'
SIGNATURE_FILES = ('author-signature.xml',)


def is_signature_file(rel):
    return rel in SIGNATURE_FILES or (rel.startswith('signature') and rel.endswith('.xml') and '/' not in rel)


def list_files(root):
    out = []
    for d, dirs, files in os.walk(root):
        dirs.sort()
        for f in sorted(files):
            full = os.path.join(d, f)
            rel = os.path.relpath(full, root).replace(os.sep, '/')
            out.append(rel)
    return out


def b64(data):
    return base64.b64encode(data).decode('ascii')


def wrap(s, n=76):
    return '\n'.join(s[i:i + n] for i in range(0, len(s), n))


def load_p12(path, password):
    with open(path, 'rb') as fh:
        data = fh.read()
    key, cert, extra = pkcs12.load_key_and_certificates(data, password.encode('utf-8') if password else None)
    if key is None or cert is None:
        sys.exit('%s: в файле нет ключа или сертификата' % path)
    chain = [cert] + [c for c in (extra or []) if c.subject != cert.subject]
    # промежуточные сертификаты — от ближнего к корню
    ordered, cur, rest = [cert], cert, chain[1:]
    while rest:
        nxt = next((c for c in rest if c.subject == cur.issuer), None)
        if nxt is None:
            ordered.extend(rest)
            break
        ordered.append(nxt)
        rest.remove(nxt)
        cur = nxt
    return key, ordered


def build_signature(root, files, sig_id, role, key, chain):
    E = '{%s}' % DSIG
    sig = etree.Element(E + 'Signature', nsmap={None: DSIG}, Id=sig_id)
    si = etree.SubElement(sig, E + 'SignedInfo')
    etree.SubElement(si, E + 'CanonicalizationMethod', Algorithm=EXC_C14N)
    is_ec = isinstance(key, ec.EllipticCurvePrivateKey)
    etree.SubElement(si, E + 'SignatureMethod', Algorithm=ECDSA_SHA256 if is_ec else RSA_SHA256)

    for rel in files:
        with open(os.path.join(root, rel), 'rb') as fh:
            digest = hashlib.sha256(fh.read()).digest()
        ref = etree.SubElement(si, E + 'Reference', URI=quote(rel, safe="/-_.~!$&'()*+,;=:@"))
        etree.SubElement(ref, E + 'DigestMethod', Algorithm=SHA256)
        etree.SubElement(ref, E + 'DigestValue').text = b64(digest)

    prop_ref = etree.SubElement(si, E + 'Reference', URI='#prop')
    tr = etree.SubElement(prop_ref, E + 'Transforms')
    etree.SubElement(tr, E + 'Transform', Algorithm=C14N11)
    etree.SubElement(prop_ref, E + 'DigestMethod', Algorithm=SHA256)
    prop_digest = etree.SubElement(prop_ref, E + 'DigestValue')

    sv = etree.SubElement(sig, E + 'SignatureValue')
    ki = etree.SubElement(sig, E + 'KeyInfo')
    xd = etree.SubElement(ki, E + 'X509Data')
    for c in chain:
        etree.SubElement(xd, E + 'X509Certificate').text = '\n' + wrap(b64(c.public_bytes(serialization.Encoding.DER))) + '\n'

    obj = etree.SubElement(sig, E + 'Object', Id='prop')
    props = etree.SubElement(obj, E + 'SignatureProperties', nsmap={'dsp': DSP})
    D = '{%s}' % DSP
    p = etree.SubElement(props, E + 'SignatureProperty', Id='profile', Target='#' + sig_id)
    etree.SubElement(p, D + 'Profile', URI='http://www.w3.org/ns/widgets-digsig#profile')
    p = etree.SubElement(props, E + 'SignatureProperty', Id='role', Target='#' + sig_id)
    etree.SubElement(p, D + 'Role', URI='http://www.w3.org/ns/widgets-digsig#role-' + role)
    p = etree.SubElement(props, E + 'SignatureProperty', Id='identifier', Target='#' + sig_id)
    etree.SubElement(p, D + 'Identifier')

    # Сериализуем и разбираем заново, чтобы канонизация шла по итоговому документу
    doc = etree.fromstring(etree.tostring(sig))
    ns = {'ds': DSIG}
    obj = doc.find('ds:Object', ns)
    # Inclusive C14N поддерева: копируем элемент в отдельный документ вместе с
    # унаследованными объявлениями пространств имён (в Object нет xml:* атрибутов,
    # поэтому результат совпадает с C14N 1.1 для подмножества документа)
    prop_c14n = etree.tostring(etree.fromstring(etree.tostring(obj)).getroottree(), method='c14n', with_comments=False)
    doc.find('ds:SignedInfo/ds:Reference[@URI="#prop"]/ds:DigestValue', ns).text = b64(hashlib.sha256(prop_c14n).digest())

    si = doc.find('ds:SignedInfo', ns)
    si_c14n = etree.tostring(si, method='c14n', exclusive=True, with_comments=False)
    if is_ec:
        der = key.sign(si_c14n, ec.ECDSA(hashes.SHA256()))
        r, s = utils.decode_dss_signature(der)
        size = (key.curve.key_size + 7) // 8
        value = r.to_bytes(size, 'big') + s.to_bytes(size, 'big')
    elif isinstance(key, rsa.RSAPrivateKey):
        value = key.sign(si_c14n, padding.PKCS1v15(), hashes.SHA256())
    else:
        sys.exit('Неподдерживаемый тип ключа: %s' % type(key).__name__)
    doc.find('ds:SignatureValue', ns).text = '\n' + wrap(b64(value)) + '\n'
    return etree.tostring(doc, encoding='UTF-8', xml_declaration=False)


def main():
    ap = argparse.ArgumentParser(description='Подпись Tizen WGT (author + distributor)')
    ap.add_argument('dir', help='каталог с содержимым виджета (config.xml в корне)')
    ap.add_argument('--author', required=True, help='author.p12')
    ap.add_argument('--author-pass', default=os.environ.get('AUTHOR_PASSWORD', ''))
    ap.add_argument('--distributor', required=True, help='distributor.p12')
    ap.add_argument('--distributor-pass', default=os.environ.get('DISTRIBUTOR_PASSWORD', ''))
    ap.add_argument('--distributor2', help='второй distributor.p12 (необязательно) → signature2.xml')
    ap.add_argument('--distributor2-pass', default=os.environ.get('DISTRIBUTOR2_PASSWORD', ''))
    a = ap.parse_args()

    root = os.path.abspath(a.dir)
    if not os.path.isfile(os.path.join(root, 'config.xml')):
        sys.exit('%s: нет config.xml' % root)
    for rel in list_files(root):
        if is_signature_file(rel):
            os.remove(os.path.join(root, rel))

    files = list_files(root)
    key, chain = load_p12(a.author, a.author_pass)
    with open(os.path.join(root, 'author-signature.xml'), 'wb') as fh:
        fh.write(build_signature(root, files, 'AuthorSignature', 'author', key, chain))

    files = list_files(root)  # теперь с author-signature.xml
    dists = [(a.distributor, a.distributor_pass)]
    if a.distributor2:
        dists.append((a.distributor2, a.distributor2_pass))
    for i, (path, pw) in enumerate(dists, 1):
        key, chain = load_p12(path, pw)
        refs = [f for f in files if not (f.startswith('signature') and f.endswith('.xml') and '/' not in f)]
        with open(os.path.join(root, 'signature%d.xml' % i), 'wb') as fh:
            fh.write(build_signature(root, refs, 'DistributorSignature', 'distributor', key, chain))
    print('Подписано: author-signature.xml, ' + ', '.join('signature%d.xml' % i for i in range(1, len(dists) + 1)))


if __name__ == '__main__':
    main()
