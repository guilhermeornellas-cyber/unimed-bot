import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';

const CONFIG = {
  urlLogin: 'https://portal.unimedlestefluminense.coop.br/ServicosPortal/Login.aspx?url=/servicosportal/default.aspx',
  usuario: '914226',
  senha: '952819',
  vencimentoAlvo: '15/11/2026'
};

async function moverMouseSobreTexto(page, textoAlvo) {
  const coords = await page.evaluate((txt) => {
    const candidatos = Array.from(document.querySelectorAll('a, li, span, td, div'));
    const alvo = candidatos.find(el => el.textContent.trim().toLowerCase() === txt.toLowerCase());
    if (!alvo) return null;
    const rect = alvo.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, textoAlvo);

  if (coords) {
    await page.mouse.move(coords.x, coords.y);
    return true;
  }
  return false;
}

async function esperarDevExpressLivre(page) {
  await page.waitForFunction(() => {
    const loadings = Array.from(document.querySelectorAll('[id*="LP"], [class*="dxlpLoadingPanel"], [class*="Loading"]'));
    return !loadings.some(el => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
    });
  }, { timeout: 30000 }).catch(() => {});
}

async function aguardarDownloadConcluir(pastaDownloads, arquivosAntes, timeoutMs = 25000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const todos = fs.readdirSync(pastaDownloads);
    const baixando = todos.some(f => f.endsWith('.crdownload') || f.endsWith('.tmp'));
    const concluidos = todos.filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
    const novo = concluidos.find(f => !arquivosAntes.includes(f));

    if (novo && !baixando) {
      return novo;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

async function clicarBotaoGrid(browser, page, vencAlvo, tipo, pastaDownloads) {
  await esperarDevExpressLivre(page);
  const arquivosAntes = fs.readdirSync(pastaDownloads);
  const abasAntes = await browser.pages();

  const infoBotao = await page.evaluate((venc, tipoDoc) => {
    const linhas = Array.from(document.querySelectorAll('table#ctl00_conteudo_grdDocumentos_DXMainTable tr, table tr'));
    const linhaAlvo = linhas.find(tr => {
      const temIcone = tr.querySelector('img[title="Faturas"], img[alt="FATURAS"], [id*="DXCBtn0"]');
      if (!temIcone) return false;
      if (venc) return (tr.textContent || '').includes(venc);
      const chkPago = tr.querySelector('input[type="checkbox"], span[class*="edtCheckBoxUnchecked"]');
      return Boolean(chkPago);
    }) || linhas.find(tr => tr.querySelector('img[title="Faturas"], img[alt="FATURAS"], [id*="DXCBtn0"]'));

    if (!linhaAlvo) return null;

    linhaAlvo.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const seletor = tipoDoc === 'FATURA'
      ? 'img[title="Faturas"], img[alt="FATURAS"], [id*="DXCBtn0"]'
      : 'img[title="Extrato"], img[alt="EXTRATO"], [id*="DXCBtn1"]';

    const el = linhaAlvo.querySelector(seletor);
    if (!el) return null;

    const clicavel = el.closest('a, [onclick], [id*="DXCBtn"]') || el;
    const rect = clicavel.getBoundingClientRect();

    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      id: clicavel.id || el.id,
      onclick: clicavel.getAttribute('onclick') || el.getAttribute('onclick') || '',
      html: clicavel.outerHTML.slice(0, 250)
    };
  }, vencAlvo, tipo);

  if (!infoBotao) {
    throw new Error(`Botão "${tipo}" não encontrado na linha da tabela.`);
  }

  console.log(`🖱️ Clicando em ${tipo} (${infoBotao.id})...`);
  if (tipo === 'EXTRATO') {
    console.log(`🔎 HTML do botão Extrato: ${infoBotao.html}`);
  }

  // Dispara o clique real no centro do botão
  await page.mouse.move(infoBotao.x, infoBotao.y);
  await new Promise(r => setTimeout(r, 250));
  await page.mouse.click(infoBotao.x, infoBotao.y);

  // Aguarda até 20s o download concluir
  let arquivoBaixado = await aguardarDownloadConcluir(pastaDownloads, arquivosAntes, 20000);
  if (arquivoBaixado) {
    console.log(`✅ ${tipo} baixado e concluído: ${arquivoBaixado}`);
    return true;
  }

  // Fallback: se o clique do mouse não disparou o postback (comum no DXCBtn1), executa o onclick/click direto no DOM
  console.log(`🔄 Tentando disparo direto via DOM/onclick para ${tipo}...`);
  await page.evaluate((idAlvo) => {
    const el = document.getElementById(idAlvo);
    if (el) {
      el.click();
    }
  }, infoBotao.id);

  arquivoBaixado = await aguardarDownloadConcluir(pastaDownloads, arquivosAntes, 15000);
  if (arquivoBaixado) {
    console.log(`✅ ${tipo} baixado via fallback: ${arquivoBaixado}`);
    return true;
  }

  // Verifica se abriu em uma nova aba
  const abasDepois = await browser.pages();
  const novaAba = abasDepois.find(p => !abasAntes.includes(p));
  if (novaAba) {
    await novaAba.bringToFront();
    await new Promise(r => setTimeout(r, 2500));
    const base64Pdf = await novaAba.evaluate(async () => {
      const iframe = document.querySelector('iframe[src*="blob:"], iframe[src*=".pdf"], iframe');
      const embed = document.querySelector('embed[src*="blob:"], embed[type="application/pdf"], object[data]');
      const url = (iframe && iframe.src && !iframe.src.startsWith('about:')) ? iframe.src :
                  (embed && (embed.src || embed.data)) ? (embed.src || embed.data) : window.location.href;
      const resp = await fetch(url);
      const blob = await resp.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }).catch(() => null);

    if (base64Pdf && base64Pdf.length > 100) {
      const nome = `${Date.now()}_${tipo}.pdf`;
      fs.writeFileSync(path.join(pastaDownloads, nome), Buffer.from(base64Pdf, 'base64'));
      console.log(`✅ ${tipo} salvo via nova aba: ${nome}`);
    }
    if (!novaAba.isClosed()) await novaAba.close();
    return true;
  }

  return false;
}

(async () => {
  const pastaDownloads = path.resolve('./downloads');
  if (!fs.existsSync(pastaDownloads)) {
    fs.mkdirSync(pastaDownloads, { recursive: true });
  }

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [
      '--start-maximized',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  });

  const browserCdp = await browser.target().createCDPSession();
  await browserCdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: pastaDownloads,
    eventsEnabled: true
  });

  const page = await browser.newPage();

  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: pastaDownloads
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  try {
    console.log('🚀 Acessando Portal Unimed Leste Fluminense...');
    await page.goto(CONFIG.urlLogin, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('⌨️ Preenchendo Usuário e Senha...');
    await page.waitForSelector('input[type="password"]', { visible: true, timeout: 30000 });

    const camposTextoVisiveis = await page.$$('input[type="text"]:not([readonly])');
    let campoUsuario = null;
    for (const inp of camposTextoVisiveis) {
      const visivel = await inp.evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (visivel) {
        campoUsuario = inp;
        break;
      }
    }

    const camposSenhaVisiveis = await page.$$('input[type="password"]');
    let campoSenha = null;
    for (const inp of camposSenhaVisiveis) {
      const visivel = await inp.evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (visivel) {
        campoSenha = inp;
        break;
      }
    }

    if (!campoUsuario || !campoSenha) {
      throw new Error('Campos de Usuário ou Senha visíveis não encontrados.');
    }

    await campoUsuario.click({ clickCount: 3 });
    await campoUsuario.type(CONFIG.usuario, { delay: 70 });

    await campoSenha.click({ clickCount: 3 });
    await campoSenha.type(CONFIG.senha, { delay: 70 });

    await new Promise(r => setTimeout(r, 600));

    console.log('🖱️ Clicando em "Entrar" (#pgcLogin_btnEntrarPJ_CD)...');
    const coordsEntrar = await page.evaluate(() => {
      const btn = document.querySelector('#pgcLogin_btnEntrarPJ_CD') ||
                  document.querySelector('input[name="pgcLogin$btnEntrarPJ"]') ||
                  Array.from(document.querySelectorAll('div.dxb, button, input[type="submit"]'))
                    .find(el => (el.textContent || el.value || '').trim().toLowerCase() === 'entrar' && el.getBoundingClientRect().width > 0);
      if (!btn) return null;
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const rect = btn.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });

    if (coordsEntrar) {
      await page.mouse.move(coordsEntrar.x, coordsEntrar.y);
      await new Promise(r => setTimeout(r, 200));
      await page.mouse.click(coordsEntrar.x, coordsEntrar.y);
    } else {
      await page.keyboard.press('Enter');
    }

    console.log('⏳ Aguardando Portal de Serviços carregar...');
    await page.waitForFunction(() => {
      return document.body.innerText.includes('Serviços') || document.body.innerText.includes('Papel Zero');
    }, { timeout: 45000 });
    await new Promise(r => setTimeout(r, 1500));

    const jaEstaNaTabela = await page.evaluate(() => {
      return Boolean(document.querySelector('img[title="Faturas"], [id*="DXCBtn0"]'));
    });

    if (!jaEstaNaTabela) {
      console.log('📂 Navegando: Serviços > Faturamento > Download de Documentos...');
      await moverMouseSobreTexto(page, 'Serviços');
      await new Promise(r => setTimeout(r, 800));

      await moverMouseSobreTexto(page, 'Faturamento');
      await new Promise(r => setTimeout(r, 800));

      const clicouDownloadDocs = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('a, li, span, td'))
          .find(e => e.textContent.trim().toLowerCase() === 'download de documentos');
        if (el) {
          const alvo = el.closest('a') || el;
          alvo.click();
          return true;
        }
        return false;
      });

      if (!clicouDownloadDocs) {
        throw new Error('Não foi possível clicar em "Download de Documentos".');
      }

      await page.waitForSelector('img[title="Faturas"], [id*="DXCBtn0"]', { visible: true, timeout: 30000 });
      await new Promise(r => setTimeout(r, 1500));
    }

    // 1. Baixa a Fatura
    await clicarBotaoGrid(browser, page, CONFIG.vencimentoAlvo, 'FATURA', pastaDownloads);

    // 2. Recarrega a página para resetar o estado de postback do DevExpress/ASP.NET
    console.log('🔄 Recarregando a página para liberar o postback do Extrato...');
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('img[title="Extrato"], [id*="DXCBtn1"]', { visible: true, timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));

    // 3. Baixa o Extrato
    const baixouExtrato = await clicarBotaoGrid(browser, page, CONFIG.vencimentoAlvo, 'EXTRATO', pastaDownloads);
    if (!baixouExtrato) {
      console.warn('⚠️ O Extrato não baixou automaticamente. Copie e cole aqui a linha "🔎 HTML do botão Extrato:" que apareceu no terminal!');
    }

    console.log(`\n🎉 Processo da Unimed concluído! Verifique a pasta: ${pastaDownloads}`);

  } catch (erro) {
    console.error('❌ Erro na automação Unimed:', erro.message);
  } finally {
    // await browser.close();
  }
})();